import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const gateway = join(root, 'backend', 'gateway');
const frontend = join(root, 'frontend');
const local = join(root, '.sitcon-dev');
const databaseDir = join(local, 'postgres');
const passwordFile = join(local, 'postgres-password');
const host = '127.0.0.1';
const apiPort = 8787;
const frontendPort = 4173;
const databasePort = 55432;
const database = 'postgres';
const user = 'sitcon_dev';
const platform = `${process.platform}-${process.arch}`;
const apiUrl = `http://${host}:${apiPort}`;
const adminUrl = `http://${host}:${frontendPort}`;
const active = new Set();
const shutdown = new AbortController();
const { promise: interrupted, resolve: interrupt } = Promise.withResolvers();

function stop() {
  shutdown.abort();
  interrupt();
}

function start(name, file, args, options = {}, stopSignal = 'SIGTERM') {
  shutdown.signal.throwIfAborted();
  const childProcess = spawn(file, args, { stdio: 'inherit', ...options });
  const { promise: done, resolve } = Promise.withResolvers();
  const child = { process: childProcess, done, stopSignal };
  active.add(child);
  childProcess.once('error', (error) => resolve(new Error(`${name}: ${error.message}`)));
  childProcess.once('close', (code, signal) => resolve(code === 0 ? undefined : new Error(`${name} exited (${signal ?? code})`)));
  void done.then(() => active.delete(child));
  return child;
}

async function npm(cwd, ...args) {
  const result = await start(`npm ${args[0]}`, process.execPath, [process.env.npm_execpath, ...args], {
    cwd, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  }).done;
  if (result) throw result;
}

async function install(cwd) {
  const hash = createHash('sha256').update(`${process.version}:${platform}\n`)
    .update(await readFile(join(cwd, 'package-lock.json'))).digest('hex');
  const stamp = join(cwd, 'node_modules', '.sitcon-install');
  const installed = await readFile(stamp, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (installed === hash) return;
  await npm(cwd, 'ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund');
  await writeFile(stamp, hash);
}

async function checkPort(port) {
  const server = createServer();
  server.listen(port, host);
  try {
    await once(server, 'listening');
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error(`Local port ${port} is already in use.`);
    throw error;
  } finally {
    server.close();
  }
}

async function waitFor(name, probe) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    const value = await probe();
    if (value) return value;
    await delay(200, undefined, { signal: shutdown.signal });
  }
  throw new Error(`${name} did not become ready.`);
}

function unexpected(child, name) {
  return child.done.then((error) => { throw error ?? new Error(`${name} stopped unexpectedly.`); });
}

async function migrate(client) {
  const migrations = join(gateway, 'prisma', 'migrations');
  await client.query('BEGIN');
  try {
    await client.query('CREATE TABLE IF NOT EXISTS sitcon_dev_migrations (name text PRIMARY KEY)');
    const { rows } = await client.query('SELECT name FROM sitcon_dev_migrations');
    const applied = new Set(rows.map(({ name }) => name));
    const folders = (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
    for (const name of folders) {
      if (applied.has(name)) continue;
      await client.query(await readFile(join(migrations, name, 'migration.sql'), 'utf8'));
      await client.query('INSERT INTO sitcon_dev_migrations (name) VALUES ($1)', [name]);
    }
    const document = JSON.stringify({ version: 1, players: {}, audit: [], phase: 'before', parameters: {}, stations: {} });
    await client.query('INSERT INTO public.sitcon_state (document) VALUES ($1) ON CONFLICT DO NOTHING', [document]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function boot() {
  if (process.versions.node.split('.')[0] !== '26') throw new Error('Node.js 26 is required.');
  if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(platform)) {
    throw new Error('Local startup requires macOS or Linux (arm64 or x64).');
  }
  if (process.getuid?.() === 0) throw new Error('Run without sudo; PostgreSQL cannot run as root.');
  await Promise.all([apiPort, frontendPort, databasePort].map(checkPort));
  await Promise.all([root, gateway, frontend].map(install));
  await Promise.all([npm(gateway, 'run', 'generate'), npm(frontend, 'run', 'build')]);

  const { postgres, initdb } = await import(`@embedded-postgres/${platform}`);
  const { default: pg } = await import('pg');
  await mkdir(local, { mode: 0o700, recursive: true });
  await writeFile(passwordFile, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const password = (await readFile(passwordFile, 'utf8')).trimEnd();
  const hasCluster = await stat(join(databaseDir, 'PG_VERSION')).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!hasCluster) {
    const result = await start('initdb', initdb, ['-D', databaseDir, '--no-instructions', '--auth=scram-sha-256',
      '--username', user, '--pwfile', passwordFile, '--encoding=UTF8', '--locale=C']).done;
    if (result) throw result;
  }
  const postgresProcess = start('PostgreSQL', postgres,
    ['-D', databaseDir, '-h', host, '-p', String(databasePort), '-k', ''], { detached: true }, 'SIGINT');
  const postgresFailure = unexpected(postgresProcess, 'PostgreSQL');
  const client = await Promise.race([postgresFailure, waitFor('PostgreSQL', async () => {
    const client = new pg.Client({ host, port: databasePort, database, user, password, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end();
      if (error.code !== 'ECONNREFUSED' && error.code !== '57P03') throw error;
    }
  })]);
  try {
    await migrate(client);
  } finally {
    await client.end();
  }

  const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
  delete env.DASHBOARD_ORIGIN;
  delete env.PUBLIC_ORIGIN;
  const backend = start('Game API', process.execPath, ['main.ts'], { cwd: gateway, detached: true, env: {
    ...env, PORT: String(apiPort), DASHBOARD_PORT: String(frontendPort), POSTGRES_HOST: host,
    POSTGRES_PORT: String(databasePort), POSTGRES_DATABASE: database, POSTGRES_USER: user,
    POSTGRES_PASSWORD_FILE: passwordFile, POSTGRES_TLS: 'disable',
  } });
  const admin = start('Admin dashboard', process.execPath, ['server.mjs'], { cwd: frontend, detached: true, env: {
    ...env, PORT: String(frontendPort), BACKEND_URL: apiUrl,
  } });
  const failure = Promise.race([postgresFailure, unexpected(backend, 'Game API'), unexpected(admin, 'Admin dashboard')]);
  await Promise.race([failure, Promise.all([apiUrl, adminUrl].map((origin) => waitFor(origin, async () => {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) }).catch(() => undefined);
    if (!response) return false;
    await response.arrayBuffer();
    return response.ok;
  })))]);
  console.log(`\nAdmin: ${adminUrl}\nAPI:   ${apiUrl}\n`);
  await failure;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await Promise.race([boot(), interrupted]);
} catch (error) {
  if (!shutdown.signal.aborted) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  // Let the HTTP services finish before shutting down their database.
  for (const child of [...active].reverse()) {
    child.process.kill(child.stopSignal);
    const deadline = setTimeout(() => child.process.kill('SIGKILL'), 7000).unref();
    await child.done;
    clearTimeout(deadline);
  }
}
