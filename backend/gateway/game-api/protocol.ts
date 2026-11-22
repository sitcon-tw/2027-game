import { GameArgumentError, GameMessage } from '../game/engine.ts';

export type JsonObject = Record<string, unknown>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly localizedMessage: GameMessage;

  constructor(status: number, code: string, message: string | GameMessage) {
    super(code);
    this.status = status;
    this.code = code;
    this.localizedMessage = typeof message === 'string' ? new GameMessage(message) : message;
  }
}

export const wrongMethod = new ApiError(405, 'method_not_allowed', 'apiMethodNotAllowed');
export const notFound = new ApiError(404, 'not_found', 'apiNotFound');
export const invalidBody = new ApiError(400, 'invalid_body', 'apiInvalidBody');
export const invalidJson = new ApiError(400, 'invalid_json', 'apiInvalidJson');

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

export function requireEmptyBody(body: JsonObject): void {
  if (Object.keys(body).length !== 0) throw invalidBody;
}

export function args(body: JsonObject): JsonObject {
  const value = body.args;
  if (!isJsonObject(value)) throw new GameArgumentError(new GameMessage('invalidArgument'));
  return value;
}

export function stringField(map: JsonObject, key: string, max: number, empty = false): string {
  const value = map[key];
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw new GameArgumentError(new GameMessage('invalidString', { field: key, max }));
  }
  return value;
}

export function optionalString(map: JsonObject, key: string, max: number): string | null {
  return map[key] == null ? null : stringField(map, key, max);
}

export function integerField(map: JsonObject, key: string, min: number, max: number): number {
  const value = map[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new GameArgumentError(new GameMessage('invalidInteger', { field: key, min, max }));
  }
  return value;
}

export function booleanField(map: JsonObject, key: string): boolean {
  const value = map[key];
  if (typeof value !== 'boolean') {
    throw new GameArgumentError(new GameMessage('invalidBoolean', { field: key }));
  }
  return value;
}
