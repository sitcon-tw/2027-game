import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { routes } from './app/routes.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const pages = new Set(routes.map(({ path }) => path));
const assetPath = /^(?:\/favicon\.svg|\/_next\/static(?:\/[A-Za-z0-9_~.@+-]+)+\.(?:css|js|json|svg|woff2?))$/;
const rscQuery = /^_rsc(?:=[A-Za-z0-9_-]+)?$/;
const renderHeaders = new Set([
  'host', 'accept', 'accept-encoding', 'accept-language', 'user-agent',
  'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch',
]);
const commonPolicy = "default-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const apiMethods = new Map([
  ['/api/health', 'GET'],
  ['/api/admin/state', 'GET'],
  ['/api/admin/actions', 'POST'],
]);
const bodyLimit = 128 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function portNumber(value, name) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return Number(value);
}

function ipv4(address) {
  return address?.startsWith('::ffff:') ? address.slice(7) : address;
}

export function isPrivateAddress(address) {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function allowsPeer(address, privateMode = false) {
  const normalized = ipv4(address);
  return normalized === '127.0.0.1' || normalized === '::1' || (privateMode && isPrivateAddress(normalized));
}

function configuredOrigin(value, name, protocols) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a canonical origin`); }
  if (!protocols.includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new Error(`${name} must be a canonical ${protocols.join(' or ')} origin without a path, credentials, query or fragment`);
  }
  return url;
}

function json(response, status, code, message) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: { code, message } }));
}

function cookieToken(header, name) {
  if (typeof header !== 'string') return undefined;
  const values = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return tokenPattern.test(value) ? value : undefined;
}

function validCsrf(request, name) {
  const cookie = cookieToken(request.headers.cookie, name);
  const header = request.headers['x-csrf-token'];
  return cookie !== undefined && typeof header === 'string' && tokenPattern.test(header)
    && timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
}

export async function createDashboardRenderer({ hostname = '127.0.0.1', port } = {}) {
  const { default: next } = await import('next');
  const app = next({ dev: false, dir: appRoot, hostname, port });
  await app.prepare();
  return app;
}

export function createDashboardServer({ backendUrl = 'http://127.0.0.1:8787', publicOrigin, render } = {}) {
  const backend = configuredOrigin(backendUrl, 'BACKEND_URL', ['http:', 'https:']);
  const publicUrl = publicOrigin === undefined ? undefined : configuredOrigin(publicOrigin, 'PUBLIC_ORIGIN', ['https:']);
  const cookieName = publicUrl ? '__Host-sitcon-csrf' : 'sitcon-csrf';
  // Next attaches a WebSocket listener on its first request; production has no upgrades.
  return http.createServer({ shouldUpgradeCallback: () => false }, async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', `${commonPolicy}; script-src 'none'; style-src 'none'`);
    if (!allowsPeer(request.socket.remoteAddress, publicUrl !== undefined)) {
      return json(response, 403, 'invalid_peer', '拒絕非允許網路的連線。');
    }
    const localPort = request.socket.localPort;
    const internalHosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    const hosts = new Set(internalHosts);
    if (publicUrl) hosts.add(publicUrl.host);
    if (!hosts.has(request.headers.host)) {
      return json(response, 403, 'invalid_host', '拒絕未設定的前端位址。');
    }
    const origins = new Set(internalHosts.map((host) => `http://${host}`));
    if (publicUrl) origins.add(publicUrl.origin);
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return json(response, 403, 'invalid_origin', '拒絕未設定的前端來源。');
    }
    const path = request.url;
    if (path === '/api/csrf') {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        return json(response, 405, 'method_not_allowed', '安全權杖僅支援 GET。');
      }
      // Reuse a valid host cookie so opening another tab does not invalidate a pending form.
      const token = cookieToken(request.headers.cookie, cookieName) ?? randomBytes(32).toString('base64url');
      response.setHeader('set-cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${publicUrl ? '; Secure' : ''}`);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ data: { token } }));
      return;
    }
    const method = apiMethods.get(path);
    if (method) {
      if (request.method !== method) {
        response.setHeader('allow', method);
        return json(response, 405, 'method_not_allowed', '此路徑不支援這個方法。');
      }
      if (method === 'POST' && request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return json(response, 415, 'unsupported_media_type', '操作必須使用 application/json。');
      }
      if (method === 'POST' && (origin === undefined || !validCsrf(request, cookieName))) {
        return json(response, 403, 'invalid_csrf', '安全權杖或來源缺失，請重新整理後再送出。');
      }
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > bodyLimit) {
            json(response, 413, 'body_too_large', '請求超過 128 KiB。');
            request.resume();
            return;
          }
          chunks.push(chunk);
        }
        // Only configured upstream + fixed paths; preserve validated browser Origin, never proxy credentials or CSRF.
        const headers = origin === undefined ? {} : { origin };
        if (method === 'POST') headers['content-type'] = 'application/json';
        const upstream = await fetch(new URL(path, backend), {
          method,
          headers,
          body: method === 'POST' ? Buffer.concat(chunks) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        const content = Buffer.from(await upstream.arrayBuffer());
        if (upstream.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
          return json(response, 502, 'invalid_backend_response', '後端未回傳 JSON，未套用資料。');
        }
        response.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(content);
      } catch {
        if (!response.headersSent) json(response, 502, 'backend_unavailable', '無法連線至後端');
      }
      return;
    }
    // Check the raw request target before passing it to Next's URL normalizer.
    // Only real pages accept Next's single flight cache-busting query.
    const [pathname, query] = path.split('?', 2);
    const page = pages.has(pathname) && (path === pathname || (
      request.headers.rsc === '1' && rscQuery.test(query) && path === `${pathname}?${query}`
    ));
    const asset = assetPath.test(path) && !/(?:^|\/)\.{1,2}\//.test(path);
    if (!page && !asset) return json(response, 404, 'not_found', '找不到此前端路徑。');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      return json(response, 405, 'method_not_allowed', '前端資源僅支援 GET / HEAD。');
    }
    if (render === undefined) return json(response, 500, 'frontend_unavailable', '無法載入前端。');
    try {
      // Next must see the same freshly issued nonce as the browser. Forward only
      // the inputs needed for pages and RSC, not cookies or routing overrides.
      for (const name of Object.keys(request.headers)) {
        if (!renderHeaders.has(name) && !(name === 'next-url' && pages.has(request.headers[name]))) delete request.headers[name];
      }
      if (page) {
        const nonce = randomBytes(16).toString('base64');
        const policy = `${commonPolicy}; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'nonce-${nonce}'`;
        request.headers['content-security-policy'] = policy;
        response.setHeader('content-security-policy', policy);
      }
      await render(request, response);
    } catch (error) {
      console.error('Dashboard rendering failed:', error);
      if (!response.headersSent) json(response, 500, 'frontend_unavailable', '無法載入前端。');
      else response.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    if (!['--port', '--backend-url', '--public-origin'].includes(flag) || !process.argv[index + 1]) {
      throw new Error('Usage: node server.mjs [--port 4173] [--backend-url http://127.0.0.1:8787] [--public-origin HTTPS_ORIGIN]');
    }
    options.set(flag, process.argv[index + 1]);
  }
  const port = portNumber(options.get('--port') ?? process.env.PORT ?? 4173, 'port');
  const backendUrl = options.get('--backend-url') ?? process.env.BACKEND_URL ?? 'http://127.0.0.1:8787';
  const publicOrigin = options.get('--public-origin') ?? process.env.PUBLIC_ORIGIN;
  const hostname = publicOrigin === undefined ? '127.0.0.1' : '0.0.0.0';
  let render;
  const server = createDashboardServer({ backendUrl, publicOrigin, render: (request, response) => render(request, response) });
  const app = await createDashboardRenderer({ hostname, port });
  render = app.getRequestHandler();
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, hostname, () => console.log(`大地遊戲：${publicOrigin ?? `http://127.0.0.1:${port}`}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => { void app.close(); });
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 1000).unref();
    });
  }
}
