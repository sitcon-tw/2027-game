import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Agent, createServer, request } from 'node:http';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import { isAllowedPeer, loopback, publicConfig } from './config.ts';
import { createPublicServer } from './public.ts';
import { createGamePersistence, createStateStore } from './state.ts';
import { createGameWorker } from './game-api/worker.ts';

const dashboard = 'https://dashboard.example.test';
const type = 'application/json; charset=utf-8';
const workerReply = '{ "error": {"code":"game_rule","message":{"code":"staffRequired","args":{}}} }\n';

async function withGateway(t, env = {}, bind) {
  const seen = [];
  const worker = createServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: await text(req) });
    res.writeHead(409, { 'content-type': type, 'access-control-allow-origin': '*' });
    res.end(workerReply);
  });
  worker.listen(0, loopback);
  await once(worker, 'listening');
  const agent = new Agent({ keepAlive: true });
  const config = publicConfig(env);
  let up = true;
  const api = createPublicServer(config, { workerPort: worker.address().port, agent, available: () => up });
  await api.listen({ port: 0, host: bind ?? (config.dashboardOrigin ? '0.0.0.0' : loopback) });
  t.after(async () => {
    await api.close();
    agent.destroy();
    await new Promise((resolve, reject) => worker.close((error) => error ? reject(error) : resolve()));
  });
  return { seen, port: api.server.address().port, host: api.server.address().address,
    workerPort: worker.address().port, markDown: () => { up = false; } };
}

function send(port, { host = loopback, method = 'GET', path = '/api/health', headers, body, chunked = false, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method, path, headers, setHost, agent: false }, async (res) => {
      try {
        resolve({ status: res.statusCode, headers: res.headers, body: await text(res) });
      } catch (error) {
        reject(error);
      }
    });
    req.once('error', reject);
    if (chunked) {
      for (const chunk of body) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });
}

function assertError(reply, status, code, message) {
  assert.equal(reply.status, status);
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(JSON.parse(reply.body), { error: { code, message: { code: message, args: {} } } });
}

test('network policy trusts only the socket address and only supported ranges', () => {
  for (const address of [null, '8.8.8.8', '100.64.0.1', '169.254.1.1', '172.32.0.0', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isAllowedPeer(address, true), false, address);
  }
  for (const address of ['10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0']) {
    assert.equal(isAllowedPeer(address, false), false);
    assert.equal(isAllowedPeer(address, true), true);
  }
  for (const address of ['127.0.0.1', '127.0.0.2', '::1']) assert.equal(isAllowedPeer(address, false), true);
  for (const bad of [`${dashboard}/`, `${dashboard}:443`, 'https://*.example.test']) {
    assert.throws(() => publicConfig({ DASHBOARD_ORIGIN: bad }), /DASHBOARD_ORIGIN/);
  }
});

test('non-loopback socket cannot substitute forwarded loopback credentials', async (t) => {
  const address = Object.values(networkInterfaces()).flat()
    .find((network) => network.family === 'IPv4' && !network.internal)?.address;
  if (!address) return t.skip('no non-loopback local IPv4 interface');
  const { port, seen } = await withGateway(t, {}, address);
  const rejected = await send(port, { host: address, headers: {
    host: `localhost:${port}`, 'x-forwarded-for': loopback, forwarded: `for=${loopback}`,
  } });
  assertError(rejected, 403, 'network_denied', 'apiNetworkDenied');
  assert.deepEqual(seen, []);
});

test('actual HTTP requests enforce Host multiplicity, Origin and preflight', async (t) => {
  const local = await withGateway(t);
  assert.equal(local.host, loopback);
  assertError(await send(local.port, { headers: { host: `10.0.10.43:${local.port}` } }), 403, 'host_denied', 'apiHostDenied');
  const { port, seen, host } = await withGateway(t, { DASHBOARD_ORIGIN: dashboard });
  assert.equal(host, '0.0.0.0');
  const goodHost = `localhost:${port}`;
  assertError(await send(port, { headers: { host: `10.0.10.43:${port}` } }), 403, 'host_denied', 'apiHostDenied');
  assertError(await send(port, { headers: { host: 'unrelated.test', 'x-forwarded-host': goodHost } }), 403, 'host_denied', 'apiHostDenied');
  assertError(await send(port, { headers: ['Host', goodHost, 'Host', goodHost] }), 403, 'host_denied', 'apiHostDenied');
  assertError(await send(port, { setHost: false }), 403, 'host_denied', 'apiHostDenied');
  const badOrigin = await send(port, { headers: { host: goodHost, origin: `${dashboard}/`, 'x-forwarded-origin': dashboard } });
  assertError(badOrigin, 403, 'origin_denied', 'apiOriginDenied');
  assert.equal(badOrigin.headers['access-control-allow-origin'], undefined);
  assertError(await send(port, { headers: ['Host', goodHost, 'Origin', dashboard, 'Origin', dashboard] }), 403, 'origin_denied', 'apiOriginDenied');
  const preflight = await send(port, { method: 'OPTIONS', path: '/unknown', headers: {
    host: goodHost, origin: dashboard, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.body, '');
  assert.equal(preflight.headers['access-control-allow-origin'], dashboard);
  assert.equal(preflight.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
  assert.equal(preflight.headers['access-control-allow-headers'], 'Content-Type');
  assert.equal(preflight.headers.vary, 'Origin');
  const denied = await send(port, { method: 'OPTIONS', headers: { origin: dashboard, 'access-control-request-headers': 'authorization' } });
  assertError(denied, 403, 'cors_denied', 'apiCorsDenied');
  assert.equal(denied.headers['access-control-allow-origin'], dashboard);
  assert.deepEqual(seen, []);
});

test('forwarding preserves body and worker status, but not user headers or private paths', async (t) => {
  const { port, seen, workerPort, markDown } = await withGateway(t, { DASHBOARD_ORIGIN: dashboard });
  const body = '{ "action": "測試", "args": { "id":9007199254740993, "marker": 1, "marker": 2 } }\n';
  const result = await send(port, { method: 'POST', path: '/api/players/demo/actions?unused=yes', body,
    headers: { origin: dashboard, host: `localhost:${port}`, 'x-forwarded-for': '8.8.8.8',
      'x-forwarded-host': 'unrelated.test', 'content-type': 'Application/JSON; charset="UTF-8"' } });
  assert.equal(result.status, 409);
  assert.equal(result.body, workerReply);
  assert.equal(result.headers['access-control-allow-origin'], dashboard);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { method: 'POST', url: '/api/players/demo/actions', body,
    headers: { host: `${loopback}:${workerPort}`, 'content-type': type,
      'content-length': String(Buffer.byteLength(body)), connection: 'keep-alive' } });
  assertError(await send(port, { method: 'DELETE' }), 405, 'method_not_allowed', 'apiMethodNotAllowed');
  assertError(await send(port, { path: '/api/players/demo/actions' }), 405, 'method_not_allowed', 'apiMethodNotAllowed');
  assertError(await send(port, { path: '/state' }), 404, 'not_found', 'apiNotFound');
  assertError(await send(port, { path: '/api/players/wrong/id/state' }), 404, 'not_found', 'apiNotFound');
  assertError(await send(port, { method: 'POST', path: '/api/health', headers: { 'content-type': type }, body: '[]' }),
    400, 'invalid_body', 'apiInvalidBody');
  assertError(await send(port, { method: 'POST', path: '/api/health', headers: { 'content-type': type }, body: '{}' }),
    404, 'not_found', 'apiNotFound');
  markDown();
  assertError(await send(port), 503, 'closing', 'apiClosing');
  assert.equal(seen.length, 1);
});

test('device authorization only reaches allowlisted worker routes and duplicates fail closed', async (t) => {
  const { port, seen } = await withGateway(t);
  const token = `Bearer ${randomBytes(32).toString('base64url')}`;
  const headers = { authorization: token, 'content-type': type };
  const id = `p-${'a'.repeat(32)}`;
  const routes = [
    ['POST', '/api/session/enroll', '{}'],
    ['POST', '/api/session/transfer', JSON.stringify({ code: 'opaque-test-code' })],
    ['GET', `/api/players/${id}/state`],
    ['POST', `/api/players/${id}/actions`, '{}'],
    ['POST', `/api/players/${id}/transfer-code`, '{}'],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await send(port, { method, path, headers, body })).status, 409);
    assert.equal(seen.at(-1).url, path);
    assert.equal(seen.at(-1).headers.authorization, token);
    assert.equal(seen.at(-1).body, body ?? '');
  }
  for (const path of ['/api/health', '/api/admin/state']) {
    assert.equal((await send(port, { path, headers })).status, 409);
    assert.equal(seen.at(-1).headers.authorization, undefined);
  }
  assert.equal((await send(port, { method: 'POST', path: '/api/admin/actions', headers, body: '{}' })).status, 409);
  assert.equal(seen.at(-1).headers.authorization, undefined);

  const duplicate = await send(port, { path: `/api/players/${id}/state`, headers: [
    'Host', `${loopback}:${port}`, 'Authorization', token, 'authorization', token,
  ] });
  assertError(duplicate, 401, 'device_session_required', 'deviceSessionRequired');
  assert.ok(!duplicate.body.includes(token));
  assertError(await send(port, { path: '/api/session/enroll', headers }), 405, 'method_not_allowed', 'apiMethodNotAllowed');
  assertError(await send(port, { method: 'POST', path: '/api/session/unknown', headers, body: '{}' }),
    404, 'not_found', 'apiNotFound');
  assert.equal(seen.length, routes.length + 3);
});

test('POST rejects encodings, charsets and oversize bodies before proxying', async (t) => {
  const { port, seen } = await withGateway(t);
  const post = { method: 'POST', path: '/api/admin/actions' };
  for (const headers of [undefined, { 'content-type': 'text/plain' }, { 'content-type': 'application/json; charset=latin1' },
    { 'content-type': type, 'content-encoding': 'gzip' }]) {
    assertError(await send(port, { ...post, headers, body: '{}' }), 415, 'json_required', 'apiJsonRequired');
  }
  const bodyLimit = 128 * 1024;
  assertError(await send(port, { ...post, headers: { 'content-type': type, 'content-length': bodyLimit + 1 }, body: 'x'.repeat(bodyLimit + 1) }),
    413, 'body_too_large', 'apiBodyTooLarge');
  assertError(await send(port, { ...post, headers: { 'content-type': type }, chunked: true, body: ['x'.repeat(bodyLimit), 'x'] }),
    413, 'body_too_large', 'apiBodyTooLarge');
  assert.deepEqual(seen, []);
});

test('worker preserves device sessions across a restart using the legacy document format', async (t) => {
  let document = JSON.stringify({ version: 1, players: {}, audit: [], phase: 'before', parameters: {}, stations: {} });
  const persistence = {
    load: async () => document,
    save: async (next) => { document = next; },
    ensureAvailable() {},
  };
  const authorization = `Bearer ${randomBytes(32).toString('base64url')}`;
  const enroll = async () => {
    const worker = createGameWorker({ persistence });
    worker.listen(0, loopback);
    await once(worker, 'listening');
    try {
      const health = await send(worker.address().port);
      assert.equal(health.status, 200, health.body);
      const result = await send(worker.address().port, {
        method: 'POST', path: '/api/session/enroll',
        headers: { authorization, 'content-type': type }, body: '{}',
      });
      assert.equal(result.status, 200, result.body);
      return JSON.parse(result.body).data.playerId;
    } finally {
      await new Promise((resolve, reject) => worker.close((error) => error ? reject(error) : resolve()));
      await worker.drain();
    }
  };
  const first = await enroll();
  assert.match(first, /^p-[a-f0-9]{32}$/);
  assert.equal(await enroll(), first);
  assert.ok(JSON.parse(document).deviceSessions[first]);
  assert.ok(!document.includes(authorization.slice(7)));
});

test('a stale PostgreSQL revision blocks writes and latches the persistence adapter', async () => {
  const legacy = '{"version":1,"players":{}}';
  let revision = 3n;
  let writes = 0;
  const prisma = {
    async $queryRaw(parts, document, expected) {
      if (parts[0].includes('UPDATE')) {
        ++writes;
        if (expected !== revision) return [];
        return [{ revision: ++revision }];
      }
      return [{ revision, document: legacy }];
    },
  };
  const persistence = createGamePersistence(createStateStore(prisma));
  assert.equal(await persistence.load(), legacy);
  await persistence.save(legacy);
  ++revision;
  await assert.rejects(persistence.save(legacy), /unavailable/);
  await assert.rejects(persistence.save(legacy), /unavailable/);
  assert.throws(() => persistence.ensureAvailable(), /unavailable/);
  assert.equal(writes, 2);
});
