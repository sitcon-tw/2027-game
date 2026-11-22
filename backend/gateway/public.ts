import { request as httpRequest, STATUS_CODES } from 'node:http';
import type { Agent, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PublicConfig } from './config.ts';
import { isAllowedPeer, loopback } from './config.ts';
import { BodyError, createServer, isJsonContentType, jsonType, readBody } from './http.ts';

const bodyLimit = 128 * 1024;
const methods = new Set(['GET', 'POST', 'OPTIONS']);
const playerRoute = /^\/api\/players\/[a-zA-Z0-9_-]{1,40}\/(state|actions|transfer-code)$/;
const sessionRoutes = new Set(['/api/session/enroll', '/api/session/transfer']);
const text = new TextDecoder('utf-8', { fatal: true });
const failures = {
  network_denied: [403, 'apiNetworkDenied'],
  host_denied: [403, 'apiHostDenied'],
  origin_denied: [403, 'apiOriginDenied'],
  cors_denied: [403, 'apiCorsDenied'],
  method_not_allowed: [405, 'apiMethodNotAllowed'],
  not_found: [404, 'apiNotFound'],
  json_required: [415, 'apiJsonRequired'],
  body_too_large: [413, 'apiBodyTooLarge'],
  invalid_json: [400, 'apiInvalidJson'],
  invalid_body: [400, 'apiInvalidBody'],
  device_session_required: [401, 'deviceSessionRequired'],
  request_timeout: [408, 'apiRequestTimeout'],
  closing: [503, 'apiClosing'],
  worker_unavailable: [503, 'apiInternalError'],
  internal_error: [500, 'apiInternalError'],
} as const;

type Failure = keyof typeof failures;

function errorDocument(kind: Failure) {
  return { error: { code: kind === 'worker_unavailable' ? 'internal_error' : kind,
    message: { code: failures[kind][1], args: {} } } };
}

function fail(reply: FastifyReply, kind: Failure) {
  return reply.code(failures[kind][0]).type(jsonType).send(errorDocument(kind));
}

function requestPath(target: string) {
  const url = URL.parse(target, 'http://gateway.invalid');
  if (!url) return '';
  // Dart normalizes unreserved escapes but not encoded slashes or separators.
  return url.pathname.replace(/%([0-9a-f]{2})/gi, (escape, hex) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[a-zA-Z0-9._~-]$/.test(char) ? char : escape;
  });
}

export function requestWorker(agent: Agent, port: number, method: string, path: string, body: Buffer | undefined, signal: AbortSignal, authorization?: string) {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const headers: OutgoingHttpHeaders = { host: `${loopback}:${port}` };
  if (authorization !== undefined) headers.authorization = authorization;
  if (body !== undefined) {
    headers['content-type'] = jsonType;
    headers['content-length'] = body.length;
  }
  const request = httpRequest({ host: loopback, port, method, path, headers, agent, signal }, resolve);
  request.once('error', reject);
  request.end(body);
  return promise;
}

export function createPublicServer(config: PublicConfig, { workerPort, agent, available }: { workerPort: number; agent: Agent; available(): boolean }) {
  const hosts = new Set(['localhost', loopback]);
  const origins = new Set([
    `http://localhost:${config.dashboardPort}`, `http://${loopback}:${config.dashboardPort}`,
  ]);
  if (config.dashboardOrigin) origins.add(config.dashboardOrigin);
  function check(raw: IncomingMessage): Failure | undefined {
    if (!isAllowedPeer(raw.socket.remoteAddress, config.dashboardOrigin !== undefined)) {
      return 'network_denied';
    }
    // Node's normal headers discard duplicate Host fields; examine all wire values.
    const { host, origin } = raw.headersDistinct;
    const authority = host?.length === 1 && /^([^:]+)(?::([0-9]+))?$/.exec(host[0]);
    if (!authority || !hosts.has(authority[1]) || Number(authority[2] ?? 80) !== raw.socket.localPort) {
      return 'host_denied';
    }
    if (origin && (origin.length !== 1 || !origins.has(origin[0]))) return 'origin_denied';
    if (!available()) return 'closing';
    if (!raw.method || !methods.has(raw.method)) return 'method_not_allowed';
  }
  const app = createServer({
    http: { requireHostHeader: false },
    // Send even unmatched targets through the same policy, independent of router
    // decoding and query handling. Only the allowlist below can reach the worker.
    rewriteUrl: () => '/',
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    const { raw, method } = request;
    const rejected = check(raw);
    if (rejected) return fail(reply, rejected);
    const headers = raw.headersDistinct;
    if ((headers.authorization?.length ?? 0) > 1) return fail(reply, 'device_session_required');
    if (headers.origin) {
      reply.header('access-control-allow-origin', headers.origin[0]).header('vary', 'Origin');
    }
    if (method === 'OPTIONS') {
      const preflightMethod = headers['access-control-request-method'];
      const preflightHeaders = headers['access-control-request-headers'];
      if ((preflightMethod?.length ?? 0) > 1) return fail(reply, 'internal_error');
      if (preflightMethod && preflightMethod[0] !== 'GET' && preflightMethod[0] !== 'POST') {
        return fail(reply, 'cors_denied');
      }
      if ((preflightHeaders?.length ?? 0) > 1) return fail(reply, 'internal_error');
      if (preflightHeaders?.[0].split(',').some((header) => header.trim().toLowerCase() !== 'content-type')) {
        return fail(reply, 'cors_denied');
      }
      return reply.code(204).header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-allow-headers', 'Content-Type').send();
    }
    if (method === 'POST') {
      const isJson = isJsonContentType(headers['content-type']?.[0]);
      if (isJson === null || (isJson && (headers['content-encoding']?.length ?? 0) > 1)) {
        return fail(reply, 'internal_error');
      }
      if (!isJson || headers['content-encoding']) return fail(reply, 'json_required');
      // The Dart MIME parser above is authoritative, not Fastify's MIME parsing.
      request.headers = { 'content-type': jsonType };
    }
  });
  async function dispatch(request: FastifyRequest, reply: FastifyReply) {
    const { method, raw } = request;
    const path = requestPath(request.originalUrl);
    const player = playerRoute.exec(path);
    const session = sessionRoutes.has(path);
    const playerRequest = method === 'GET' ? player?.[1] === 'state'
      : player?.[1] === 'actions' || player?.[1] === 'transfer-code' || session;
    const forward = playerRequest || (method === 'GET'
      ? path === '/api/health' || path === '/api/admin/state' : path === '/api/admin/actions');
    let body;
    if (method === 'POST') {
      try {
        body = await readBody(raw, bodyLimit);
      } catch (error) {
        if (!(error instanceof BodyError)) throw error;
        if (error.kind === 'request_closed') return reply.hijack();
        reply.header('connection', 'close');
        return fail(reply, error.kind);
      }
      // On an unmatched POST, the Dart API validates the body before reporting
      // the route error. For matched routes, Dart validates the original bytes.
      if (!forward) {
        let value;
        try {
          value = JSON.parse(text.decode(body));
        } catch {
          return fail(reply, 'invalid_json');
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return fail(reply, 'invalid_body');
        }
      }
    }
    if (!forward) return fail(reply, player || session ? 'method_not_allowed' : 'not_found');
    if (!available()) return fail(reply, 'closing');
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    let response;
    try {
      const authorization = playerRequest ? raw.headersDistinct.authorization?.[0] : undefined;
      response = await requestWorker(agent, workerPort, method, path, body, controller.signal, authorization);
    } catch {
      if (controller.signal.aborted) return reply.hijack();
      return fail(reply, available() ? 'worker_unavailable' : 'closing');
    }
    reply.code(response.statusCode!);
    for (const header of ['content-type', 'content-length']) {
      if (response.headers[header] !== undefined) reply.header(header, response.headers[header]);
    }
    return reply.send(response);
  }
  app.get('/', dispatch);
  app.post('/', dispatch);
  app.setNotFoundHandler((_request, reply) => fail(reply, 'not_found'));
  app.setErrorHandler((_error, _request, reply) => fail(reply, 'internal_error'));
  // Node dispatches CONNECT outside its HTTP request event. Never open a tunnel.
  app.server.on('connect', (raw, socket) => {
    const kind = check(raw) ?? 'method_not_allowed';
    const status = failures[kind][0];
    const content = JSON.stringify(errorDocument(kind));
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n` +
      `Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Type: ${jsonType}\r\n` +
      `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`);
  });
  return app;
}
