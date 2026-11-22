import { Buffer } from 'node:buffer';
import { createServer, STATUS_CODES } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { isIPv4 } from 'node:net';
import { GameArgumentError, GameStateError } from '../game/engine.ts';
import { BodyError, isJsonContentType, jsonType, readBody } from '../http.ts';
import { ApiError, invalidBody, invalidJson, isJsonObject, wrongMethod } from './protocol.ts';
import type { JsonObject } from './protocol.ts';
import { GameApi } from './routes.ts';
import { StorageUnavailable } from './store.ts';
import type { Persistence } from './store.ts';

export type { Persistence } from './store.ts';

const bodyLimit = 128 * 1024;
const text = new TextDecoder('utf-8', { fatal: true });
const hosts = /^(?:127\.0\.0\.1|localhost)(?::([0-9]+))?$/;
const networkDenied = new ApiError(403, 'network_denied', 'apiNetworkDenied');
const hostDenied = new ApiError(403, 'host_denied', 'apiHostDenied');
const originDenied = new ApiError(403, 'origin_denied', 'apiOriginDenied');
const corsDenied = new ApiError(403, 'cors_denied', 'apiCorsDenied');
const closingError = new ApiError(503, 'closing', 'apiClosing');
const jsonRequired = new ApiError(415, 'json_required', 'apiJsonRequired');
const bodyTooLarge = new ApiError(413, 'body_too_large', 'apiBodyTooLarge');
const requestTimeout = new ApiError(408, 'request_timeout', 'apiRequestTimeout');
const unavailable = new ApiError(503, 'storage_unavailable', 'apiInternalError');
const internalError = new ApiError(500, 'internal_error', 'apiInternalError');

export interface GameWorker extends Server {
  drain(): Promise<void>;
}

function pathFrom(target: string): string {
  const url = URL.parse(target, 'http://worker.invalid');
  if (!url) return '';
  // Dart normalizes unreserved escapes, not encoded separators.
  return url.pathname.replace(/%([0-9a-f]{2})/gi, (escape, hex) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[a-zA-Z0-9._~-]$/.test(char) ? char : escape;
  });
}

async function jsonBody(request: IncomingMessage): Promise<JsonObject> {
  const headers = request.headersDistinct;
  if (headers['content-type']?.length !== 1 ||
      !isJsonContentType(headers['content-type'][0]) || headers['content-encoding']) throw jsonRequired;
  const bytes: Buffer = await readBody(request, bodyLimit);
  let value: unknown;
  try {
    const document = text.decode(bytes);
    // Dart distinguishes integer tokens from doubles, even when both have
    // the same value. Box only double literals so integer fields reject them.
    value = /[0-9][.eE]/.test(document)
      ? JSON.parse(document, (_key, parsed, context?: { source?: string }) =>
        typeof parsed === 'number' && /[.eE]/.test(context?.source ?? '') ? new Number(parsed) : parsed)
      : JSON.parse(document);
  } catch {
    throw invalidJson;
  }
  if (!isJsonObject(value)) throw invalidBody;
  return value;
}

function failureFor(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof GameArgumentError) return new ApiError(422, 'invalid_argument', error.localizedMessage);
  if (error instanceof GameStateError) {
    const message = error.localizedMessage;
    if (message.code === 'operatorPermission' || message.code === 'staffRequired') {
      return new ApiError(403, 'role_forbidden', message);
    }
    return new ApiError(409, 'game_rule', message);
  }
  if (error instanceof StorageUnavailable) return unavailable;
  if (error instanceof BodyError) {
    if (error.kind === 'body_too_large') return bodyTooLarge;
    if (error.kind === 'request_timeout') return requestTimeout;
  }
  return internalError;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', jsonType);
  response.end(body);
}

export function createGameWorker({ persistence, clock = () => new Date() }: {
  persistence: Persistence;
  clock?: () => Date;
}): GameWorker {
  const api = new GameApi(persistence, clock);
  const ready = api.initialize();
  // Await startup in every handler; a failing load still needs an observer
  // when no request has arrived yet.
  void ready.catch(() => {});
  let closing = false;
  const server = createServer({ keepAliveTimeout: 10_000 }, (request, response) => {
    void handle(request, response);
  });
  server.maxHeadersCount = 0;
  server.on('connect', (request, socket) => {
    let failure = wrongMethod;
    try {
      checkRequest(request);
    } catch (error) {
      failure = failureFor(error);
    }
    const body = JSON.stringify({ error: { code: failure.code, message: failure.localizedMessage.toJson() } });
    socket.end(`HTTP/1.1 ${failure.status} ${STATUS_CODES[failure.status]}\r\nConnection: close\r\n` +
      `Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Type: ${jsonType}\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });

  function checkRequest(request: IncomingMessage): string | undefined {
    const address = request.socket.remoteAddress;
    if (address !== '::1' && !(address && isIPv4(address) && address.startsWith('127.'))) throw networkDenied;
    const bound = server.address();
    const headers = request.headersDistinct;
    const host = headers.host?.length === 1 ? hosts.exec(headers.host[0]) : null;
    if (!host || !bound || typeof bound === 'string' || Number(host[1] ?? 80) !== bound.port) throw hostDenied;
    const origins = headers.origin;
    const origin = origins?.[0];
    if (origins && (origins.length !== 1 || (origin !== 'http://127.0.0.1:4173' && origin !== 'http://localhost:4173'))) {
      throw originDenied;
    }
    if (closing) throw closingError;
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'OPTIONS') throw wrongMethod;
    return origin;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      const origin = checkRequest(request);
      if (origin !== undefined) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        const headers = request.headersDistinct;
        const method = headers['access-control-request-method'];
        const fields = headers['access-control-request-headers'];
        if ((method && (method.length !== 1 || (method[0] !== 'GET' && method[0] !== 'POST'))) ||
            (fields && (fields.length !== 1 || fields[0].split(',').some(h => h.trim().toLowerCase() !== 'content-type')))) {
          throw corsDenied;
        }
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'Content-Type');
        response.statusCode = 204;
        response.end();
        return;
      }
      const method = request.method!;
      const path = pathFrom(request.url ?? '');
      if (method === 'GET' && path === '/api/health') {
        await ready;
        json(response, 200, { data: await api.health() });
      } else {
        const body = method === 'POST' ? await jsonBody(request) : null;
        await ready;
        if (closing) throw closingError;
        const data = await api.request(method, path, body, request.headersDistinct.authorization);
        json(response, 200, { data });
      }
    } catch (error) {
      if (response.destroyed || (error instanceof BodyError && error.kind === 'request_closed')) return;
      const failure = failureFor(error);
      if (!request.complete) response.setHeader('connection', 'close');
      json(response, failure.status, { error: { code: failure.code, message: failure.localizedMessage.toJson() } });
    }
  }

  let drained: Promise<void> | undefined;
  const drain = () => {
    closing = true;
    return drained ??= ready.then(() => api.drain(), () => api.drain());
  };
  server.once('close', () => { void drain(); });
  return Object.assign(server, { drain });
}
