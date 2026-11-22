import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { allowsPeer, createDashboardRenderer, createDashboardServer, isPrivateAddress, portNumber } from './server.mjs';
import { describeApiError } from './app/api_error.js';
import { routes } from './app/routes.js';

let nextApp;
async function renderWithNext(request, response) {
  nextApp ??= createDashboardRenderer();
  return (await nextApp).getRequestHandler()(request, response);
}
test.after(async () => { if (nextApp) await (await nextApp).close(); });

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
function shutdown(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function csrfHeaders(origin, headers = {}) {
  const response = await fetch(`${origin}/api/csrf`, { headers });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.match(data.token, /^[A-Za-z0-9_-]{43}$/);
  return {
    ...headers,
    origin: headers.origin ?? origin,
    'content-type': 'application/json',
    cookie: response.headers.get('set-cookie').split(';')[0],
    'x-csrf-token': data.token,
  };
}

async function rawRequest(origin, path, headers = {}, method = 'GET', body) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('port parsing rejects invalid and non-loopback-target port syntax', () => {
  assert.equal(portNumber('4173', 'port'), 4173);
  for (const value of [0, -1, 65536, '8787/path', '1.2', 'example.com']) {
    assert.throws(() => portNumber(value, 'port'));
  }
});

test('gateway proxies only fixed admin API paths without credentials', async (context) => {
  const received = [];
  const backend = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, method: request.method, body: Buffer.concat(chunks).toString(), origin: request.headers.origin, cookie: request.headers.cookie, csrf: request.headers['x-csrf-token'], authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream-secret=example; Path=/' });
    response.end(JSON.stringify({ data: { mode: 'test', source: 'upstream' } }));
  });
  const backendPort = await listen(backend);
  const frontend = createDashboardServer({ backendUrl: `http://127.0.0.1:${backendPort}` });
  const port = await listen(frontend);
  context.after(async () => { await shutdown(frontend); await shutdown(backend); });
  const origin = `http://127.0.0.1:${port}`;
  const headers = await csrfHeaders(origin);
  const action = { action: 'remotePacks', args: { playerId: 'demo', deliveryId: 'one', amount: 2, reason: 'test' } };
  const response = await fetch(`${origin}/api/admin/actions`, { method: 'POST', headers: { ...headers, authorization: 'Bearer local-only' }, body: JSON.stringify(action) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.source, 'upstream');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(received, [{ path: '/api/admin/actions', method: 'POST', body: JSON.stringify(action), origin, cookie: undefined, csrf: undefined, authorization: undefined }]);
  assert.equal((await fetch(`${origin}/api/admin/actions`, { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/admin/actions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${origin}/api/admin/state`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${origin}/api/players/demo/actions`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${origin}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/api/admin/state?url=https://other.example`)).status, 404);
  assert.equal((await fetch(`${origin}/api/admin/state?_rsc=abcdef`, { headers: { rsc: '1' } })).status, 404);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${origin}/`, { headers: { host: 'other.example' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal(received.length, 1);
});

test('Next renders six distinct dashboard pages with fresh matching strict CSP nonces', async (context) => {
  const frontend = createDashboardServer({ render: renderWithNext });
  const port = await listen(frontend);
  context.after(() => shutdown(frontend));
  const origin = `http://127.0.0.1:${port}`;
  const nonces = new Set();
  for (const { path, title } of [...routes, routes[0]]) {
    const page = await fetch(`${origin}${path}`, { headers: { 'content-security-policy': "script-src 'nonce-untrusted'" } });
    assert.equal(page.status, 200, path);
    const policy = page.headers.get('content-security-policy');
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /'strict-dynamic'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|nonce-untrusted/);
    assert.match(page.headers.get('cache-control'), /no-store/);
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.equal(nonces.has(nonce), false, 'nonce is unique even on repeat requests');
    nonces.add(nonce);
    const html = await page.text();
    assert.match(html, /lang="zh-Hant"/);
    assert.match(html, new RegExp(`<h1 [^>]*>${title}</h1>`));
    assert.match(html, new RegExp(`<a(?=[^>]*aria-current="page")(?=[^>]*href="${path}")[^>]*>`));
    const scripts = html.match(/<script\b[^>]*>/g);
    assert.ok(scripts?.length > 1, 'Next scripts are part of the server-rendered document');
    for (const script of scripts) assert.ok(script.includes(`nonce="${nonce}"`), script);
    if (path === '/') {
      const script = scripts.find((tag) => tag.includes('src="/_next/static/'))?.match(/src="([^"]+)"/)?.[1];
      const stylesheet = html.match(/<link\b(?=[^>]*rel="stylesheet")[^>]*href="([^"]+)"/)?.[1];
      assert.match(script, /^\/_next\/static\//);
      assert.match(stylesheet, /^\/_next\/static\//);
      assert.match((await rawRequest(origin, script)).headers['content-type'], /javascript/);
      assert.match((await rawRequest(origin, stylesheet)).headers['content-type'], /text\/css/);
    }
  }
  const flight = await rawRequest(origin, '/players?_rsc', { rsc: '1' });
  assert.equal(flight.status, 200);
  assert.match(flight.headers['content-type'], /^text\/x-component/);
  for (const path of ['/index.html', '/app.js', '/styles.css', '/players?debug=x', '/unknown', '/players?_rsc=123']) {
    assert.equal((await rawRequest(origin, path)).status, 404, path);
  }
  assert.equal((await rawRequest(origin, '/_next/static/%2e%2e/server.js')).status, 404);
  assert.equal((await rawRequest(origin, '/event', {}, 'POST')).headers.allow, 'GET, HEAD');
});

test('proxy preserves authoritative role state and exact assignment payloads', async (context) => {
  const received = [];
  let player = { id: 'demo', role: 'user', boothId: null };
  const backend = http.createServer(async (request, response) => {
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const action = JSON.parse(Buffer.concat(chunks).toString());
      received.push(action);
      player = { id: action.args.playerId, role: action.args.role, boothId: action.args.boothId ?? null };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { mode: 'test', players: [player], stations: [] } }));
  });
  const backendPort = await listen(backend);
  const frontend = createDashboardServer({ backendUrl: `http://127.0.0.1:${backendPort}` });
  const port = await listen(frontend);
  context.after(async () => { await shutdown(frontend); await shutdown(backend); });
  const origin = `http://127.0.0.1:${port}`;
  const initial = await (await fetch(`${origin}/api/admin/state`)).json();
  assert.deepEqual(initial.data.players, [{ id: 'demo', role: 'user', boothId: null }]);
  const headers = await csrfHeaders(origin);
  const assignments = [
    { playerId: 'demo', role: 'booth', boothId: 'booth-2' },
    { playerId: 'demo', role: 'staff' },
    { playerId: 'demo', role: 'user' },
  ];
  for (const args of assignments) {
    const response = await fetch(`${origin}/api/admin/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'role', args }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.data.players, [{ id: 'demo', role: args.role, boothId: args.boothId ?? null }]);
    assert.equal(Object.hasOwn(result.data.players[0], 'staff'), false);
  }
  assert.deepEqual(received, assignments.map((args) => ({ action: 'role', args })));
});

test('backend offline reports a real gateway error rather than fake health', async (context) => {
  const unused = http.createServer();
  const backendPort = await listen(unused);
  await shutdown(unused);
  const frontend = createDashboardServer({ backendUrl: `http://127.0.0.1:${backendPort}` });
  const port = await listen(frontend);
  context.after(() => shutdown(frontend));
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'backend_unavailable');
});

test('structured game errors and gateway text remain readable', () => {
  assert.equal(describeApiError({ code: 'insufficientCoins', args: {} }), 'Insufficient coins');
  assert.equal(describeApiError('測試後端未連線'), '測試後端未連線');
});

test('configuration accepts remote backend origins and rejects ambiguous deployment configuration', () => {
  const server = createDashboardServer({ backendUrl: 'https://api.example.test:9443' });
  server.close();
  assert.equal(isPrivateAddress('10.0.10.43'), true);
  assert.equal(isPrivateAddress('172.16.1.2'), true);
  assert.equal(isPrivateAddress('192.168.1.2'), true);
  for (const address of ['127.0.0.1', '172.15.1.2', '172.32.1.2', '192.169.1.2', '0.0.0.0', '8.8.8.8', '::1', '10.1']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  for (const backendUrl of ['file:///etc/passwd', 'https://user:pass@api.example.test', 'https://api.example.test/', 'https://api.example.test/path', 'https://api.example.test?target=x', 'https://api.example.test#x']) {
    assert.throws(() => createDashboardServer({ backendUrl }));
  }
  for (const publicOrigin of ['http://admin.example.test', 'https://admin.example.test/', 'https://admin.example.test/path', 'https://user@admin.example.test', 'https://admin.example.test:443']) {
    assert.throws(() => createDashboardServer({ publicOrigin }));
  }
  assert.equal(allowsPeer('127.0.0.1'), true);
  assert.equal(allowsPeer('::1'), true);
  assert.equal(allowsPeer('::ffff:127.0.0.1'), true);
  assert.equal(allowsPeer('10.0.10.5'), false);
  assert.equal(allowsPeer('::ffff:10.0.10.5', true), true);
  for (const peer of ['8.8.8.8', '2001:db8::1', 'fc00::1', undefined]) assert.equal(allowsPeer(peer, true), false);
});

test('HTTPS deployment permits exact public and internal authorities without trusting forwarded headers', async (context) => {
  const received = [];
  const backend = http.createServer((request, response) => {
    received.push(request.headers);
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"data":{"mode":"test"}}');
  });
  const backendPort = await listen(backend);
  const publicOrigin = 'https://admin.example.test';
  const frontend = createDashboardServer({ backendUrl: `http://127.0.0.1:${backendPort}`, publicOrigin, render: renderWithNext });
  const port = await listen(frontend);
  context.after(async () => { await shutdown(frontend); await shutdown(backend); });
  const origin = `http://127.0.0.1:${port}`;
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'admin.example.test']) {
    assert.equal((await rawRequest(origin, '/', { host })).status, 200, host);
  }
  for (const host of ['admin.example.test:443', 'admin.example.test.evil', 'ADMIN.EXAMPLE.TEST', `10.0.10.43:${port}`, 'evil.example']) {
    assert.equal((await rawRequest(origin, '/', { host, 'x-forwarded-host': 'admin.example.test', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' })).status, 403, host);
  }
  for (const badOrigin of ['null', 'http://admin.example.test', `${publicOrigin}/`, 'https://admin.example.test:443', 'https://admin.example.test.evil']) {
    assert.equal((await rawRequest(origin, '/api/admin/state', { host: 'admin.example.test', origin: badOrigin, 'x-forwarded-origin': publicOrigin })).status, 403, badOrigin);
  }
  const csrfResponse = await rawRequest(origin, '/api/csrf', { host: 'admin.example.test' });
  const token = JSON.parse(csrfResponse.body).data.token;
  const setCookie = csrfResponse.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-sitcon-csrf=/);
  assert.match(setCookie, /; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
  assert.doesNotMatch(setCookie, /Domain=/i);
  const headers = { host: 'admin.example.test', origin: publicOrigin, cookie: setCookie.split(';')[0], 'x-csrf-token': token, 'content-type': 'application/json' };
  assert.equal((await rawRequest(origin, '/api/admin/actions', headers, 'POST', '{}')).status, 200);
  assert.equal(received[0].origin, publicOrigin);
  assert.equal(received[0].host, `127.0.0.1:${backendPort}`);
  assert.equal(received[0].cookie, undefined);
  assert.equal(received[0]['x-csrf-token'], undefined);
  assert.equal(received[0]['x-forwarded-host'], undefined);
  assert.equal((await rawRequest(origin, '/api/admin/state', { host: 'admin.example.test' })).status, 200);
  assert.equal(received[1].origin, undefined, 'native reads do not receive a forged browser Origin');
});

test('mutations require exact Origin and matching random host cookie/header tokens', async (context) => {
  let calls = 0;
  const backend = http.createServer((request, response) => {
    ++calls;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"data":{"mode":"test"}}');
  });
  const backendPort = await listen(backend);
  const frontend = createDashboardServer({ backendUrl: `http://127.0.0.1:${backendPort}` });
  const port = await listen(frontend);
  context.after(async () => { await shutdown(frontend); await shutdown(backend); });
  const origin = `http://127.0.0.1:${port}`;
  const headers = await csrfHeaders(origin);
  const other = await csrfHeaders(origin);
  assert.notEqual(headers['x-csrf-token'], other['x-csrf-token']);
  const cookieResponse = await fetch(`${origin}/api/csrf`, { headers: { cookie: headers.cookie } });
  assert.equal((await cookieResponse.json()).data.token, headers['x-csrf-token'], 'another tab reuses host token');
  assert.match(cookieResponse.headers.get('set-cookie'), /HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(cookieResponse.headers.get('set-cookie'), /Secure|Domain=/i);
  const invalid = [
    { ...headers, cookie: '' },
    { ...headers, 'x-csrf-token': '' },
    { ...headers, 'x-csrf-token': other['x-csrf-token'] },
    { ...headers, 'x-csrf-token': 'short' },
    { ...headers, cookie: `${headers.cookie}; ${headers.cookie}` },
    { ...headers, origin: 'https://evil.example' },
  ];
  const noOrigin = { ...headers };
  delete noOrigin.origin;
  invalid.push(noOrigin);
  for (const attempt of invalid) {
    const response = await fetch(`${origin}/api/admin/actions`, { method: 'POST', headers: attempt, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0, 'rejected submissions never reach backend');
  assert.equal((await fetch(`${origin}/api/csrf?token=x`)).status, 404);
  assert.equal((await fetch(`${origin}/api/csrf`, { method: 'POST' })).status, 405);
  const large = await fetch(`${origin}/api/admin/actions`, { method: 'POST', headers, body: 'x'.repeat(128 * 1024 + 1) });
  assert.equal(large.status, 413);
  assert.equal(calls, 0);
  assert.equal((await fetch(`${origin}/api/admin/actions`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(calls, 1);
});

test('configured hostname backend is used and redirects or HTML cannot masquerade as successful API data', async (context) => {
  let mode = 'json';
  const backend = http.createServer((request, response) => {
    request.resume();
    if (mode === 'redirect') {
      response.writeHead(302, { location: '/api/health' });
      response.end();
    } else if (mode === 'html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<h1>not an API</h1>');
    } else {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end('{"error":{"code":"real_conflict","message":"upstream conflict"}}');
    }
  });
  backend.listen(0);
  await once(backend, 'listening');
  const backendPort = backend.address().port;
  const frontend = createDashboardServer({ backendUrl: `http://localhost:${backendPort}` });
  const port = await listen(frontend);
  context.after(async () => { await shutdown(frontend); await shutdown(backend); });
  const url = `http://127.0.0.1:${port}/api/health`;
  const conflict = await fetch(url);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'real_conflict');
  mode = 'redirect';
  assert.equal((await fetch(url)).status, 502);
  mode = 'html';
  const html = await fetch(url);
  assert.equal(html.status, 502);
  assert.equal((await html.json()).error.code, 'invalid_backend_response');
});
