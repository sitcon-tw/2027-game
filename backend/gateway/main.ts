import { Agent } from 'node:http';
import { readFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './build/prisma/client.ts';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loopback, postgresConfig, publicConfig, workerPort } from './config.ts';
import { createPublicServer, requestWorker } from './public.ts';
import { createGamePersistence, createStateStore } from './state.ts';
import { createGameWorker } from './game-api/worker.ts';
import type { GameWorker } from './game-api/worker.ts';

async function awaitWorker(agent: Agent, stopping: AbortSignal) {
  const deadline = AbortSignal.any([stopping, AbortSignal.timeout(20_000)]);
  while (!deadline.aborted) {
    try {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(1000)]);
      const response = await requestWorker(agent, workerPort, 'GET', '/api/health', undefined, signal);
      response.resume();
      await finished(response, { cleanup: true });
      if (response.statusCode === 200) return;
    } catch {
      // The loopback port is not accepting worker requests until startup finishes.
    }
    await delay(100, undefined, { signal: deadline });
  }
  deadline.throwIfAborted();
}

async function closeListener(app: FastifyInstance) {
  const force = setTimeout(() => app.server.closeAllConnections(), 5000).unref();
  try {
    await app.close();
  } finally {
    clearTimeout(force);
  }
}

async function run(env: NodeJS.ProcessEnv) {
  const config = publicConfig(env);
  const { ADMIN_USERNAME: username, ADMIN_PASSWORD_FILE: passwordFile } = env;
  let adminCredential: string | undefined;
  if (username !== undefined || passwordFile !== undefined || config.dashboardOrigin) {
    if (!username || /[:\r\n]/.test(username) || !passwordFile) throw new ConfigError('Admin credentials must be configured');
    const password = (await readFile(passwordFile, 'utf8')).trimEnd();
    if (password.length < 16) throw new ConfigError('Admin password must contain at least 16 characters');
    adminCredential = Buffer.from(`${username}:${password}`).toString('base64');
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg(await postgresConfig(env)) });
  const persistence = createGamePersistence(createStateStore(prisma));
  const agent = new Agent({ keepAlive: true });
  const stopping = new AbortController();
  const stopped = Promise.withResolvers<number>();
  let ready = false;
  let worker: GameWorker | undefined;
  const api = createPublicServer(config, { workerPort, agent, adminCredential, available: () => ready });
  function stop(code: number) {
    if (stopping.signal.aborted) return;
    ready = false;
    stopping.abort();
    stopped.resolve(code);
  }
  const onSignal = () => stop(0);
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    await prisma.$connect();
    stopping.signal.throwIfAborted();
    worker = createGameWorker({ persistence });
    const listening = once(worker, 'listening');
    worker.listen(workerPort, loopback);
    await listening;
    await awaitWorker(agent, stopping.signal);
    stopping.signal.throwIfAborted();
    ready = true;
    const host = config.dashboardOrigin ? '0.0.0.0' : loopback;
    await api.listen({ host, port: config.port });
    if (ready) {
      console.log(`SITCON TEST API listening on ${host}:${config.port} ` +
        '(independent demo fixtures, no production authentication)');
    }
  } catch {
    if (!stopping.signal.aborted) {
      console.error('Could not start the SITCON API gateway or access game state');
      stop(1);
    }
  }
  try {
    return await stopped.promise;
  } finally {
    // Drain public traffic before removing the worker's persistence listener.
    try {
      await closeListener(api);
    } finally {
      agent.destroy();
      try {
        if (worker) {
          const drained = once(worker, 'close');
          worker.close();
          const force = setTimeout(() => worker?.closeAllConnections(), 5000).unref();
          try {
            await drained;
            await worker.drain();
          } finally {
            clearTimeout(force);
          }
        }
      } finally {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        await prisma.$disconnect();
      }
    }
  }
}

try {
  process.exitCode = await run(process.env);
} catch (error) {
  // Keep any connection and filesystem details out of process logs.
  console.error(error instanceof ConfigError ? error.message : 'SITCON API gateway failed');
  process.exitCode = error instanceof ConfigError ? 64 : 1;
}
