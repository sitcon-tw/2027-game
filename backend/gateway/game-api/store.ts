import type { EventPhase, GameStorage, StationWire } from '../game/engine.ts';

export interface Persistence {
  load(): Promise<string>;
  save(document: string): Promise<void>;
  ensureAvailable(): void | Promise<void>;
  checkHealth?(): Promise<void>;
}

export class StorageUnavailable extends Error {}

type Index<T> = Record<string, T>;
type Transfer = { hash: string; expiresAt: number; redeemed?: boolean };
type DeviceSession = { activeHash: string; transfer?: Transfer };
export type BattlePick = [card: number, shown: number, automatic: boolean];
export type BattleRound = [BattlePick, BattlePick, outcome: number];
export type BattleRoom = {
  id: string;
  a: string;
  b: string;
  deadline: number;
  accepted?: boolean;
  waitingReady?: boolean;
  readyA?: boolean;
  readyB?: boolean;
  rounds?: BattleRound[];
  pickA?: BattlePick | null;
  pickB?: BattlePick | null;
  peekA?: readonly number[];
  peekB?: readonly number[];
};
type SessionIndexes = {
  deviceTokens: Index<string>;
  deviceSessions: Index<DeviceSession>;
  incomingFriendOffers: Index<Index<number>>;
  outgoingFriendOffers: Index<Index<number>>;
  attendeeBattleSeats: Index<string>;
  attendeeBattles: Index<BattleRoom>;
};
export type PlayerState = {
  badge: string | null;
  bindings: Index<string>;
  ledger: { at: string; reason: string; detail: string }[];
  checkpoints: Index<string>;
  scans: Index<{ source: string; kind?: string; message?: { args?: Record<string, unknown> } }>;
};
type AuditEntry = {
  at: string;
  actor: string;
  action: string;
  playerId: unknown;
  detail: string;
};
type Document = Partial<SessionIndexes> & {
  version: 1;
  players: Index<PlayerState>;
  audit: AuditEntry[];
  phase: EventPhase;
  parameters: Index<number>;
  stations: Index<StationWire>;
  bindings: Index<string>;
  bindingConflicts: string[];
};

function copyIndex<T>(index: Index<T>): Index<T> {
  return Object.assign(Object.create(null), index);
}

const emptyIndex = Object.freeze(Object.create(null));

async function storageOperation<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new StorageUnavailable('Game state storage is unavailable', { cause });
  }
}

// A single document commits all players, global settings and audit atomically.
export class Store {
  #persistence: Persistence;
  #dirty = false;
  #transaction = false;
  rolledBackChanges = false;
  data!: Document;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async load(): Promise<void> {
    const document = await storageOperation(() => this.#persistence.load());
    const data = JSON.parse(document) as Document;
    if (data?.version !== 1) throw new Error('Unsupported test server data version');
    data.bindings = copyIndex(data.bindings ?? emptyIndex);
    data.bindingConflicts ??= [];
    // Preserve legacy fixtures, promoting only unambiguous station bindings.
    for (const state of Object.values(data.players)) {
      for (const [uid, station] of Object.entries(state.bindings)) {
        if (Object.hasOwn(data.bindings, uid) && data.bindings[uid] !== station) {
          if (!data.bindingConflicts.includes(uid)) data.bindingConflicts.push(uid);
        } else {
          data.bindings[uid] = station;
        }
      }
    }
    this.data = data;
  }

  async ensureAvailable(): Promise<void> {
    await storageOperation(() => this.#persistence.ensureAvailable());
  }

  async checkHealth(): Promise<void> {
    await storageOperation(() => this.#persistence.checkHealth
      ? this.#persistence.checkHealth()
      : this.#persistence.ensureAvailable());
  }

  sessionMap<K extends keyof SessionIndexes>(key: K): Readonly<SessionIndexes[K]> {
    return this.data[key] ?? emptyIndex;
  }

  // Session indexes are copied only on writes so unused indexes stay absent.
  editSessionMap<K extends keyof SessionIndexes>(key: K): SessionIndexes[K] {
    this.changed();
    const next = Object.assign(Object.create(null), this.data[key]) as SessionIndexes[K];
    const indexes: Partial<SessionIndexes> = this.data;
    indexes[key] = next;
    return next;
  }

  changed(): void {
    if (!this.#transaction) throw new Error('Persistence outside transaction');
    this.#dirty = true;
  }

  async transaction<T>(body: () => T | Promise<T>): Promise<T> {
    if (this.#transaction) throw new Error('Nested transaction');
    this.rolledBackChanges = false;
    await this.ensureAvailable();
    const previous = this.data;
    this.data = {
      ...previous,
      players: copyIndex(previous.players),
      audit: [...previous.audit],
      parameters: copyIndex(previous.parameters),
      stations: copyIndex(previous.stations),
      bindings: copyIndex(previous.bindings),
      bindingConflicts: [...previous.bindingConflicts],
    };
    this.#transaction = true;
    this.#dirty = false;
    try {
      const result = await body();
      if (this.#dirty) {
        const document = JSON.stringify(this.data);
        await storageOperation(() => this.#persistence.save(document));
      }
      return result;
    } catch (error) {
      this.rolledBackChanges = this.#dirty;
      this.data = previous;
      throw error;
    } finally {
      this.#transaction = false;
      this.#dirty = false;
    }
  }
}

export class PlayerStorage implements GameStorage {
  #store: Store;
  #playerId: string;
  #loaded: string | null = null;

  constructor(store: Store, playerId: string) {
    this.#store = store;
    this.#playerId = playerId;
  }

  async read(): Promise<string | null> {
    const state = this.#store.data.players[this.#playerId];
    return this.#loaded = state == null ? null : JSON.stringify(state);
  }

  async write(value: string): Promise<void> {
    // The core writes its loaded document on initialize, even if unchanged.
    const loaded = this.#loaded;
    this.#loaded = null;
    if (value === loaded) return;
    this.#store.data.players[this.#playerId] = JSON.parse(value);
    this.#store.changed();
  }
}
