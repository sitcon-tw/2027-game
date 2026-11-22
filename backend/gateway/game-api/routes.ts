import { randomInt } from 'node:crypto';
import {
  AccountRole, EventPhase, GameArgumentError, GameEngine, GameMessage, GameStateError, PlayerCard,
  ScannerMode, ScanResult, Station, cardIndex, gameToWire, handCards, hatchToWire, scanToWire,
  stationFromWire, stationToWire,
} from '../game/engine.ts';
import type { GameWire } from '../game/engine.ts';
import { stamp } from '../game/time.ts';
import { DeviceSessions } from './device-sessions.ts';
import { Multiplayer } from './multiplayer.ts';
import type { MultiplayerWire } from './multiplayer.ts';
import {
  ApiError, args, booleanField, integerField, notFound, optionalString, requireEmptyBody, stringField, wrongMethod,
} from './protocol.ts';
import type { JsonObject } from './protocol.ts';
import { PlayerStorage, Store } from './store.ts';
import type { Persistence } from './store.ts';
import { adminSnapshot } from './admin-snapshot.ts';

const playerRoute = /^\/api\/players\/([a-zA-Z0-9_-]{1,40})\/(state|actions|transfer-code)$/;
const playerId = /^[a-zA-Z0-9_-]{1,40}$/;
const playerActions = {
  bindBadge: true, saveProfile: true, finishTutorial: true, claimEarly: true, scan: true,
  requestFriend: true, respondFriend: true, simulateReciprocalScan: true, inviteBattle: true,
  respondBattle: true, readyBattle: true, cancelBattle: true, playCard: true, usePeek: true,
  tick: true, openPacks: true, buyEgg: true, selectAppearance: true, redeemHint: true, bindStation: true,
};
const playerActionForbidden = new ApiError(403, 'player_action_forbidden', 'apiPlayerActionForbidden');
const playerNotFound = new ApiError(404, 'player_not_found', 'apiPlayerNotFound');
// Only recognized fields enter the audit, never ignored credentials.
const auditedAdminArgs: Readonly<Record<string, readonly string[]>> = {
  replaceBadge: ['playerId', 'expectedUid', 'uid'],
  adjustInventory: ['playerId', 'resource', 'delta', 'expected', 'reason'],
  phase: ['phase'],
  agenda: ['slot'],
  remotePacks: ['playerId', 'deliveryId', 'amount', 'reason'],
  photo: ['playerId'],
  boothComplete: ['playerId', 'boothId'],
  role: ['playerId', 'role', 'boothId'],
  station: ['stationId', 'name', 'packs', 'limit', 'remaining', 'open'],
};
const zeroAllowed = { missionCoins: true, battleWinCoins: true, battleDrawCoins: true };
const demoBadgeUids = new Set(Array.from({ length: 18 }, (_, i) => GameEngine.playerUid(i + 1)));
const nonBadgeUids = new Set([
  ...Array.from({ length: 42 }, (_, i) => GameEngine.checkpointUid(i + 1)),
  ...Array.from({ length: 3 }, (_, i) => GameEngine.boothUid(i + 1)),
  ...Array.from({ length: 4 }, (_, i) => GameEngine.stationUid(i + 1)),
]);

type Player = [id: string, core: GameEngine];

export class GameApi {
  #store: Store;
  #clock: () => Date;
  #sessions: DeviceSessions;
  #multiplayer: Multiplayer;
  #players = new Map<string, GameEngine>();
  #instance = `${Date.now() * 1000}-${randomInt(2 ** 32)}`;
  #tail = Promise.resolve();
  #sequence = 0;

  constructor(persistence: Persistence, clock: () => Date) {
    this.#store = new Store(persistence);
    this.#clock = clock;
    this.#sessions = new DeviceSessions(this.#store, clock);
    this.#multiplayer = new Multiplayer(this.#store, clock, id => this.#player(id), this.#sessions);
  }

  async initialize(): Promise<void> {
    await this.#store.load();
    await this.#exclusive(() => this.#player('demo'));
  }

  async health(): Promise<{ status: string; mode: string }> {
    await this.#store.checkHealth();
    return { status: 'ok', mode: 'test' };
  }

  async drain(): Promise<void> {
    await this.#tail;
    for (const player of this.#players.values()) player.dispose();
    this.#players.clear();
  }

  #exclusive<T>(body: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      try {
        return await this.#store.transaction(body);
      } catch (error) {
        // A failed multi-player transaction invalidates mutated cached cores.
        if (this.#store.rolledBackChanges) {
          for (const player of this.#players.values()) player.dispose();
          this.#players.clear();
        }
        throw error;
      }
    });
    this.#tail = result.then(() => {}, () => {});
    return result;
  }

  async #player(id: string): Promise<GameEngine> {
    if (!playerId.test(id)) throw notFound;
    const existing = this.#players.get(id);
    if (existing) return existing;
    const data = this.#store.data;
    const fresh = !Object.hasOwn(data.players, id);
    const core = new GameEngine({
      storage: new PlayerStorage(this.#store, id),
      clock: this.#clock,
      importedNickname: id === 'demo' ? 'OPass 測試會眾' : `測試會眾 ${id}`,
    });
    try {
      await core.initialize();
      if (fresh) {
        if (data.phase !== EventPhase.before) await core.setMockPhase(data.phase);
        if (Object.keys(data.parameters).length) await core.configureParameters(data.parameters);
        for (const station of Object.values(data.stations)) await core.configureStation(stationFromWire(station));
      }
      core.useGlobalBindings(data.bindings, { conflicts: new Set(data.bindingConflicts) });
      this.#players.set(id, core);
      return core;
    } catch (error) {
      core.dispose();
      throw error;
    }
  }

  async #allPlayers(): Promise<Player[]> {
    const players: Player[] = [];
    for (const id of Object.keys(this.#store.data.players)) players.push([id, await this.#player(id)]);
    return players;
  }

  async #playerState(id: string, core: GameEngine, actionResult?: { result: unknown }) {
    const state: GameWire & { multiplayer?: MultiplayerWire } = gameToWire(core);
    if (this.#sessions.isEnrolled(id)) {
      const { liveBattle, multiplayer } = await this.#multiplayer.snapshot(id, core);
      if (liveBattle != null) state.battle = liveBattle;
      state.multiplayer = multiplayer;
    }
    return {
      state,
      serverTime: stamp(this.#clock()),
      sequence: ++this.#sequence,
      instance: this.#instance,
      ...actionResult,
    };
  }

  request(method: string, path: string, body: JsonObject | null, authorization: readonly string[] | undefined) {
    return this.#exclusive(() => this.#route(method, path, body, authorization));
  }

  async #route(method: string, path: string, body: JsonObject | null, authorization: readonly string[] | undefined) {
    if (path === '/api/admin/state' && method === 'GET') return this.#adminState();
    if (path === '/api/admin/actions' && method === 'POST') {
      const action = stringField(body!, 'action', 80);
      const a = args(body!);
      await this.#adminAction(action, a);
      const auditArgs = action === 'parameters' ? a : Object.fromEntries(
        auditedAdminArgs[action].filter(key => Object.hasOwn(a, key)).map(key => [key, a[key]]),
      );
      this.#store.data.audit.push({
        at: stamp(this.#clock()),
        actor: 'local-test-admin',
        action,
        playerId: auditArgs.playerId ?? 'all',
        detail: JSON.stringify(auditArgs),
      });
      this.#store.changed();
      return this.#adminState();
    }
    if (path === '/api/session/enroll' || path === '/api/session/transfer') {
      if (method !== 'POST') throw wrongMethod;
      const token = DeviceSessions.tokenHash(authorization);
      if (path === '/api/session/transfer') return { playerId: this.#sessions.transfer(body!.code, token) };
      requireEmptyBody(body!);
      const existing = this.#sessions.playerFor(token);
      if (existing != null) return { playerId: existing };
      const id = this.#sessions.enroll(token);
      await this.#player(id);
      return { playerId: id };
    }
    const match = playerRoute.exec(path);
    if (!match) throw notFound;
    const [, id, endpoint] = match;
    if (method !== (endpoint === 'state' ? 'GET' : 'POST')) throw wrongMethod;
    if (endpoint === 'transfer-code') {
      requireEmptyBody(body!);
      return { code: this.#sessions.issueTransfer(id, DeviceSessions.tokenHash(authorization)) };
    }
    this.#sessions.requirePlayer(id, DeviceSessions.tokenHash(authorization));
    // Reject admin attempts before loading/creating player accounts.
    const action = body == null ? null : stringField(body, 'action', 80);
    if (action != null && !Object.hasOwn(playerActions, action)) throw playerActionForbidden;
    const core = await this.#player(id);
    await this.#multiplayer.advance(id);
    await core.tick();
    if (action == null) return this.#playerState(id, core);
    const result = await this.#playerAction(id, core, action, args(body!));
    return this.#playerState(id, core, { result });
  }

  async #playerAction(actor: string, core: GameEngine, action: string, a: JsonObject): Promise<unknown> {
    switch (action) {
      case 'bindBadge':
        await core.bindBadge(this.#availableBadgeUid(actor, a));
        break;
      case 'saveProfile': {
        const tags = a.tags;
        if (!Array.isArray(tags) || tags.length > 9 || tags.some(t => typeof t !== 'string')) {
          throw new GameArgumentError(new GameMessage('invalidTagList'));
        }
        await core.saveProfile(tags, stringField(a, 'contact', 1000, true), { nickname: optionalString(a, 'nickname', 120) });
        break;
      }
      case 'finishTutorial':
        await core.finishTutorial();
        break;
      case 'claimEarly':
        await core.claimEarly();
        break;
      case 'scan': {
        const mode = Object.hasOwn(a, 'mode') ? stringField(a, 'mode', 10) : ScannerMode.user;
        if (mode !== ScannerMode.user && mode !== ScannerMode.staff && mode !== ScannerMode.booth) {
          throw new GameArgumentError(new GameMessage('invalidScannerMode'));
        }
        return scanToWire(await this.#scan(actor, core, stringField(a, 'uid', 100), stringField(a, 'scanId', 160), mode));
      }
      case 'requestFriend': {
        const peer = stringField(a, 'playerId', 100);
        if (DeviceSessions.reservedId(peer)) await this.#multiplayer.requestFriend(actor, core, peer);
        else await core.requestFriend(peer);
        break;
      }
      case 'respondFriend':
        await this.#multiplayer.respondFriend(actor, core, stringField(a, 'playerId', 40), booleanField(a, 'accept'));
        break;
      case 'simulateReciprocalScan':
        await core.simulateReciprocalScan(stringField(a, 'playerId', 100));
        break;
      case 'inviteBattle': {
        const peer = stringField(a, 'playerId', 100);
        if (DeviceSessions.reservedId(peer)) await this.#multiplayer.invite(actor, core, peer);
        else {
          if (this.#multiplayer.roomFor(actor)) throw new GameStateError(new GameMessage('battleBusy'));
          await core.inviteBattle(peer);
        }
        break;
      }
      case 'respondBattle':
        await this.#multiplayer.respond(actor, core, stringField(a, 'battleId', 100), booleanField(a, 'accept'));
        break;
      case 'readyBattle':
        this.#multiplayer.ready(actor, stringField(a, 'battleId', 100), integerField(a, 'round', 0, 2));
        break;
      case 'cancelBattle':
        if (Object.hasOwn(a, 'battleId') || this.#multiplayer.roomFor(actor)) {
          this.#multiplayer.cancel(actor, stringField(a, 'battleId', 100));
        } else await core.cancelBattle();
        break;
      case 'playCard': {
        const card = handCards[integerField(a, 'card', 0, 3)];
        const asCard = a.asCard == null ? null : handCards[integerField(a, 'asCard', 0, 3)];
        if (Object.hasOwn(a, 'battleId') || this.#multiplayer.roomFor(actor)) {
          await this.#multiplayer.play(actor, core, stringField(a, 'battleId', 100), integerField(a, 'round', 0, 2), card, asCard);
        } else await core.playCard(card, { asCard });
        break;
      }
      case 'usePeek':
        if (Object.hasOwn(a, 'battleId') || this.#multiplayer.roomFor(actor)) {
          await this.#multiplayer.peek(actor, core, stringField(a, 'battleId', 100), integerField(a, 'round', 0, 2));
        } else await core.usePeek();
        break;
      case 'tick':
        await core.tick();
        break;
      case 'openPacks':
        return (await core.openPacks({ all: Object.hasOwn(a, 'all') ? booleanField(a, 'all') : false })).map(cardIndex);
      case 'buyEgg':
        return hatchToWire(await core.buyEgg({ series: a.series == null ? null : integerField(a, 'series', 0, 5) }));
      case 'selectAppearance':
        await core.selectAppearance(a.planet == null ? null : integerField(a, 'planet', 0, 41), integerField(a, 'style', -1, 5));
        break;
      case 'redeemHint':
        return (await core.redeemHint()).toJson();
      case 'bindStation': {
        if (core.role !== AccountRole.staff) throw new GameStateError(new GameMessage('staffRequired'));
        const uid = GameEngine.normalizeUid(stringField(a, 'uid', 100));
        const data = this.#store.data;
        if (Object.values(data.players).some(p => p.badge === uid)) throw new GameStateError(new GameMessage('uidReserved'));
        const stationId = stringField(a, 'stationId', 48);
        await core.bindStation(uid, stationId);
        data.bindings[uid] = stationId;
        this.#store.changed();
        const conflicts = new Set(data.bindingConflicts);
        for (const player of this.#players.values()) player.useGlobalBindings(data.bindings, { conflicts });
        break;
      }
      default:
        throw playerActionForbidden;
    }
    return null;
  }

  async #scan(actorId: string, actor: GameEngine, uid: string, scanId: string, mode: ScannerMode): Promise<ScanResult> {
    const normalized = GameEngine.normalizeUid(uid);
    const prior = actor.replayScan(normalized, scanId, mode);
    if (prior != null) return prior;
    const playerScan = mode === ScannerMode.user;
    if (playerScan && (!actor.checkedIn || actor.badgeUid === normalized)) return actor.scan(normalized, scanId, { mode });
    const { players, bindings, bindingConflicts } = this.#store.data;
    let targetId: string | undefined;
    for (const [id, player] of Object.entries(players)) {
      if (player.badge !== normalized) continue;
      if (targetId !== undefined) throw new GameStateError(new GameMessage('ambiguousBadge'));
      targetId = id;
    }
    if (!playerScan && (targetId === actorId || (targetId === undefined && normalized === GameEngine.selfUid))) {
      throw new GameStateError(new GameMessage('operatorSelfScan'));
    }
    if (targetId === undefined) {
      if (mode === ScannerMode.booth || (!playerScan && demoBadgeUids.has(normalized))) {
        throw new GameStateError(new GameMessage('attendeeBadgeRequired'));
      }
      return actor.scan(normalized, scanId, { mode });
    }
    // Legacy badge collisions with station/checkpoint tags fail closed.
    if (Object.hasOwn(bindings, normalized) || bindingConflicts.includes(normalized) || nonBadgeUids.has(normalized)) {
      throw new GameStateError(new GameMessage('ambiguousBadge'));
    }
    if (playerScan && !this.#sessions.isEnrolled(targetId)) return actor.scan(normalized, scanId, { mode });
    const target = await this.#player(targetId);
    if (playerScan && !target.checkedIn) return actor.scan(normalized, scanId, { mode });
    const profile = target.me;
    const player = playerScan ? Multiplayer.publicCard(targetId, target) : new PlayerCard({
      id: targetId,
      name: profile.name,
      tags: profile.tags,
      contact: profile.contact,
      planet: profile.planet,
      style: profile.style,
      roles: profile.roles,
    });
    const fields = { uid: normalized, player, targetPlayerId: targetId };
    let result: ScanResult;
    if (playerScan) result = new ScanResult('attendee', new GameMessage('scan.player'), fields);
    else if (mode === ScannerMode.staff) result = new ScanResult('staffPlayer', new GameMessage('staffIdentity'), fields);
    else {
      const id = actor.boothId!;
      const repeated = await target.completeBoothTask(id);
      result = new ScanResult('boothComplete', new GameMessage(repeated ? 'boothAlreadyComplete' : 'boothTaskComplete'), {
        ...fields, booth: target.booths.find(b => b.id === id)!, repeated,
      });
    }
    return actor.recordResolvedScan(normalized, scanId, mode, result);
  }

  async #target(a: JsonObject): Promise<Player> {
    const id = stringField(a, 'playerId', 40);
    if (id === 'all' || !Object.hasOwn(this.#store.data.players, id)) throw playerNotFound;
    return [id, await this.#player(id)];
  }

  #availableBadgeUid(id: string, a: JsonObject): string {
    const uid = GameEngine.normalizeUid(stringField(a, 'uid', 100));
    const { players, bindings, bindingConflicts } = this.#store.data;
    if (Object.hasOwn(bindings, uid) || bindingConflicts.includes(uid)) throw new GameStateError(new GameMessage('notBadge'));
    if (Object.entries(players).some(([playerId, player]) => playerId !== id && player.badge === uid)) {
      throw new GameStateError(new GameMessage('badgeTaken'));
    }
    return uid;
  }

  async #adminAction(action: string, a: JsonObject): Promise<void> {
    const data = this.#store.data;
    switch (action) {
      case 'replaceBadge': {
        const [id, target] = await this.#target(a);
        const expected = stringField(a, 'expectedUid', 14, true);
        if ((target.badgeUid ?? '') !== expected) throw new GameStateError(new GameMessage('badgeBindingChanged'));
        await target.replaceBadge(this.#availableBadgeUid(id, a));
        break;
      }
      case 'adjustInventory': {
        const [id, target] = await this.#target(a);
        const resource = stringField(a, 'resource', 20);
        const delta = integerField(a, 'delta', -10000, 10000);
        if (delta < 0 && handCards.some(card => card === resource)) {
          await this.#multiplayer.advance(id);
          if (this.#multiplayer.roomFor(id)?.accepted === true) {
            throw new GameStateError(new GameMessage('inventoryBattleActive'));
          }
        }
        await target.adjustInventory({ resource, delta,
          expected: integerField(a, 'expected', 0, Number.MAX_SAFE_INTEGER), reason: stringField(a, 'reason', 200).trim(),
        });
        break;
      }
      case 'phase': {
        const phase = stringField(a, 'phase', 10);
        if (phase !== EventPhase.before && phase !== EventPhase.active && phase !== EventPhase.ended) {
          throw new GameArgumentError(new GameMessage('invalidPhase'));
        }
        for (const [, core] of await this.#allPlayers()) await core.setMockPhase(phase);
        data.phase = phase;
        this.#store.changed();
        break;
      }
      case 'agenda': {
        const slot = stringField(a, 'slot', 120);
        if (data.phase !== EventPhase.active) throw new GameStateError(new GameMessage('eventInactive'));
        for (const [, core] of await this.#allPlayers()) if (core.checkedIn) await core.simulateAgenda(slot);
        break;
      }
      case 'remotePacks': {
        const id = stringField(a, 'deliveryId', 120);
        const amount = integerField(a, 'amount', 1, 10000);
        const reason = stringField(a, 'reason', 1000);
        const targets = stringField(a, 'playerId', 40) === 'all' ? await this.#allPlayers() : [await this.#target(a)];
        for (const [, core] of targets) await core.simulateRemotePacks(id, amount, reason);
        break;
      }
      case 'photo': {
        const [, core] = await this.#target(a);
        await core.simulatePhotoReward();
        break;
      }
      case 'boothComplete': {
        const boothId = stringField(a, 'boothId', 80);
        const [, core] = await this.#target(a);
        await core.simulateBoothCompletion(boothId);
        break;
      }
      case 'role': {
        const role = stringField(a, 'role', 10);
        if (role !== AccountRole.user && role !== AccountRole.staff && role !== AccountRole.booth) {
          throw new GameArgumentError(new GameMessage('invalidAccountRole'));
        }
        const boothId = optionalString(a, 'boothId', 80);
        const [, core] = await this.#target(a);
        await core.configureRole(role, { boothId });
        break;
      }
      case 'station': {
        const station = new Station({
          id: stringField(a, 'stationId', 48), name: stringField(a, 'name', 120),
          packs: integerField(a, 'packs', 1, 100), limit: integerField(a, 'limit', 1, 100),
          remaining: integerField(a, 'remaining', 0, 100000), open: booleanField(a, 'open'),
        });
        for (const [, core] of await this.#allPlayers()) await core.configureStation(station);
        data.stations[station.id] = stationToWire(station);
        this.#store.changed();
        break;
      }
      case 'parameters': {
        const keys = Object.keys(a);
        if (!keys.length || keys.some(key => !Object.hasOwn(GameEngine.defaultParameters, key))) {
          throw new GameArgumentError(new GameMessage('unknownParameter'));
        }
        const parameters: Record<string, number> = {};
        for (const key of keys) {
          parameters[key] = integerField(a, key, Object.hasOwn(zeroAllowed, key) ? 0 : 1, key === 'agendaPacks' ? 3 : 3600);
        }
        for (const [, core] of await this.#allPlayers()) await core.configureParameters(parameters);
        Object.assign(data.parameters, parameters);
        this.#store.changed();
        break;
      }
      default:
        throw new ApiError(422, 'unknown_admin_action', 'apiUnknownAdminAction');
    }
  }

  async #adminState() {
    const players = await this.#allPlayers();
    for (const [, core] of players) await core.tick();
    const demo = await this.#player('demo');
    return adminSnapshot(this.#store, players, demo, this.#clock);
  }
}
