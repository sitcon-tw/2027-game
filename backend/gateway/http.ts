import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import type { IncomingMessage, ServerOptions } from 'node:http';
import { Buffer } from 'node:buffer';

export const jsonType = 'application/json; charset=utf-8';
const emptyBody = Buffer.alloc(0);

export function createServer(options: FastifyServerOptions & { http?: ServerOptions } = {}) {
  const app = Fastify({ trustProxy: false, exposeHeadRoutes: false, keepAliveTimeout: 10_000, ...options });
  // Keep the byte cap, but do not silently drop fields before cardinality checks.
  app.server.maxHeadersCount = 0;
  // The caller checks headers and consumes bytes without Fastify's default JSON
  // normalization. Neither integer literals nor duplicate keys are rewritten.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
  return app;
}

// Parse MIME parameters like Dart's ContentType, including quoted charset and
// last-valued duplicate parameters. null means the header is malformed.
export function isJsonContentType(value: string | undefined) {
  if (value === undefined) return false;
  const media = /^[ \t]*([^ \t;]*)[ \t]*;?/.exec(value);
  if (!media) return null;
  const parameter = /[ \t]*([^ \t;=]*)[ \t]*(?:=[ \t]*(?:"((?:[^"\\]|\\.)*)"|([^" \t;]*))[ \t]*)?(;|$)/y;
  parameter.lastIndex = media[0].length;
  let charset;
  while (parameter.lastIndex < value.length) {
    const match = parameter.exec(value);
    if (!match) return null;
    if (match[1].toLowerCase() === 'charset') {
      charset = (match[2]?.replace(/\\(.)/g, '$1') ?? match[3])?.toLowerCase();
    }
  }
  return media[1].toLowerCase() === 'application/json' && (charset === undefined || charset === 'utf-8');
}

export class BodyError extends Error {
  readonly kind: 'body_too_large' | 'request_timeout' | 'request_closed';
  constructor(kind: BodyError['kind']) {
    super(kind);
    this.kind = kind;
  }
}

export function readBody(raw: IncomingMessage, limit: number) {
  if (Number(raw.headers['content-length']) > limit) throw new BodyError('body_too_large');
  if (raw.readableEnded) return Promise.resolve(emptyBody);
  return new Promise<Buffer>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const deadline = setTimeout(() => {
      raw.pause();
      finish(new BodyError('request_timeout'));
    }, 10_000);
    function finish(error?: Error) {
      clearTimeout(deadline);
      raw.off('data', onData);
      raw.off('end', finish);
      raw.off('close', onClose);
      raw.off('error', onClose);
      if (error) reject(error);
      else resolve(chunks.length > 1 ? Buffer.concat(chunks, size) : chunks[0] ?? emptyBody);
    }
    function onData(chunk: Buffer) {
      size += chunk.length;
      if (size > limit) {
        raw.pause();
        finish(new BodyError('body_too_large'));
      } else {
        chunks.push(chunk);
      }
    }
    function onClose() {
      finish(new BodyError('request_closed'));
    }
    raw.on('data', onData).once('end', finish).once('close', onClose).once('error', onClose);
  });
}
