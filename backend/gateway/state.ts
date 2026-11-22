import type { PrismaClient } from './build/prisma/client.ts';
import type { Persistence } from './game-api/worker.ts';

interface StateStore {
  read(): Promise<string | undefined>;
  write(document: string): Promise<boolean>;
  healthy(): Promise<boolean>;
}

export function createStateStore(prisma: Pick<PrismaClient, '$queryRaw'>): StateStore {
  let revision: bigint | undefined;
  let tail: Promise<void> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>) {
    const result = tail.then(operation);
    tail = result.then(() => {}, () => {});
    return result;
  }
  return {
    read: () => serialize(async () => {
      const [row] = await prisma.$queryRaw<{ revision: bigint; document: string }[]>`
        SELECT revision, document::text AS document
        FROM public.sitcon_state WHERE singleton = true
      `;
      if (!row || (revision !== undefined && row.revision !== revision)) return undefined;
      revision = row.revision;
      return row.document;
    }),
    write: (document) => serialize(async () => {
      if (revision === undefined) return false;
      const [row] = await prisma.$queryRaw<{ revision: bigint }[]>`
        UPDATE public.sitcon_state
        SET document = ${document}::json, revision = revision + 1
        WHERE singleton = true AND revision = ${revision}::bigint
        RETURNING revision
      `;
      if (!row) return false;
      revision = row.revision;
      return true;
    }),
    healthy: () => serialize(async () => {
      const [row] = await prisma.$queryRaw<{ revision: bigint }[]>`
        SELECT revision FROM public.sitcon_state WHERE singleton = true
      `;
      return !!row && (revision === undefined || revision === row.revision);
    }),
  };
}

export function createGamePersistence(store: StateStore): Persistence {
  let failed = false;
  function ensureAvailable() {
    if (failed) throw new Error('Game state unavailable');
  }
  async function requireState<T>(operation: () => Promise<T>, unavailable: T) {
    ensureAvailable();
    try {
      const value = await operation();
      if (value === unavailable) throw new Error('Game state unavailable');
      return value;
    } catch (error) {
      failed = true;
      throw error;
    }
  }
  return {
    async load() {
      const document = await requireState(store.read, undefined);
      if (document === undefined) throw new Error('Game state unavailable');
      return document;
    },
    async save(document) {
      await requireState(() => store.write(document), false);
    },
    ensureAvailable,
    async checkHealth() {
      await requireState(store.healthy, false);
    },
  };
}
