import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './protocol.ts';
import type { Store } from './store.ts';

const ttl = 10 * 60 * 1000;
// For 32 bytes, the last base64url character has four significant bits.
const secretPattern = '[a-zA-Z0-9_-]{42}[AEIMQUYcgkosw048]';
const secret = new RegExp(`^${secretPattern}$`);
const transferCode = new RegExp(`^(p-[a-f0-9]{32})\\.(${secretPattern})$`);
const required = new ApiError(401, 'device_session_required', 'deviceSessionRequired');
const invalid = new ApiError(400, 'device_transfer_invalid', 'deviceTransferInvalid');
const conflict = new ApiError(409, 'device_session_conflict', 'deviceSessionConflict');

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Only called within the worker's serialized store transaction.
export class DeviceSessions {
  #store: Store;
  #clock: () => Date;

  constructor(store: Store, clock: () => Date) {
    this.#store = store;
    this.#clock = clock;
  }

  static reservedId(id: string): boolean {
    return id.toLowerCase().startsWith('p-');
  }

  static tokenHash(authorization: readonly string[] | undefined): string {
    if (authorization?.length !== 1) throw required;
    const value = authorization[0];
    if (value.length !== 50 || value.slice(0, 7).toLowerCase() !== 'bearer ') throw required;
    const token = value.slice(7);
    if (!secret.test(token)) throw required;
    return hash(token);
  }

  playerFor(token: string): string | undefined {
    return this.#store.sessionMap('deviceTokens')[token];
  }

  isEnrolled(id: string): boolean {
    return Object.hasOwn(this.#store.sessionMap('deviceSessions'), id);
  }

  requirePlayer(id: string, token: string): void {
    if (this.playerFor(token) !== id) throw required;
  }

  enroll(token: string): string {
    const existing = Object.keys(this.#store.data.players);
    let id: string;
    do {
      id = `p-${randomBytes(16).toString('hex')}`;
    } while (existing.some(playerId => playerId.length === id.length && playerId.toLowerCase() === id));
    this.#store.editSessionMap('deviceTokens')[token] = id;
    this.#store.editSessionMap('deviceSessions')[id] = { activeHash: token };
    return id;
  }

  issueTransfer(id: string, token: string): string {
    this.requirePlayer(id, token);
    const code = randomBytes(32).toString('base64url');
    this.#store.editSessionMap('deviceSessions')[id] = {
      activeHash: token,
      transfer: { hash: hash(code), expiresAt: this.#clock().getTime() + ttl },
    };
    return `${id}.${code}`;
  }

  transfer(code: unknown, token: string): string {
    const match = typeof code === 'string' && code.length === 78 && transferCode.exec(code);
    if (!match) throw invalid;
    const [, id, codeSecret] = match;
    const session = this.#store.sessionMap('deviceSessions')[id];
    const transfer = session?.transfer;
    if (!transfer) throw invalid;
    const candidate = Buffer.from(hash(codeSecret));
    const expected = Buffer.from(transfer.hash);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw invalid;
    if (transfer.redeemed === true) {
      // Recover a lost success response only for the device that redeemed it.
      if (this.playerFor(token) === id) return id;
      throw invalid;
    }
    if (this.#clock().getTime() >= transfer.expiresAt) throw invalid;
    if (this.playerFor(token) != null) throw conflict;
    const tokens = this.#store.editSessionMap('deviceTokens');
    delete tokens[session.activeHash];
    tokens[token] = id;
    this.#store.editSessionMap('deviceSessions')[id] = {
      activeHash: token,
      transfer: { ...transfer, redeemed: true },
    };
    return id;
  }
}
