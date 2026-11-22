import {
  Battle, BattleRecord, Booth, Checkpoint, GameArgumentError, GameMessage, GameStateError,
  HatchResult, LedgerEntry, Mission, PlayerCard, RankEntry, RoundResult, ScanResult, Station,
  cardIndex, handCards,
} from './service.ts';
import type { AccountRole, EventPhase, GameView, MessageWire } from './service.ts';
import { optionalDate, parseDate, stamp } from './time.ts';

// Public protocol. Private core persistence is never sent to players.
export const gameWireVersion = 3;
export const rankingMetrics = Object.freeze(['points', 'friends', 'planets', 'checkpoints', 'missions'] as const);

export interface PrivatePlayerWire {
  id: string;
  name: string;
  tags: readonly string[];
  contact?: string;
  planet?: number | null;
  style?: number;
}
export interface PlayerWire extends Required<PrivatePlayerWire> {
  roles: readonly string[];
}
export interface BoothWire {
  id: string;
  name: string;
  url: string;
  visited: boolean;
  completed: boolean;
}
export interface StationWire {
  id: string;
  name: string;
  packs: number;
  limit: number;
  remaining: number;
  open: boolean;
}
export interface RoundWire {
  mine: number;
  opponent: number;
  outcome: number;
  automatic: boolean;
  wild: boolean;
}
export interface BattleWire<Player = PlayerWire> {
  id: string;
  opponent: Player;
  deadline: string;
  accepted: boolean;
  finished: boolean;
  peekUsed: boolean;
  opponentHand: readonly number[];
  rounds: readonly RoundWire[];
}
export interface ScanWire<Player = PlayerWire> {
  kind: string;
  message: MessageWire;
  uid: string | null;
  player: Player | null;
  booth: BoothWire | null;
  station: StationWire | null;
  targetPlayerId: string | null;
  repeated: boolean;
  openPacks: boolean;
}
export interface HatchWire {
  planet: number;
  seriesCompleted: boolean;
}
export interface LedgerWire {
  at: string;
  reason: string;
  detail: string;
  coins: number;
  args?: Readonly<Record<string, unknown>>;
}
export interface BattleRecordWire<Player = PlayerWire> {
  battle: BattleWire<Player>;
  at: string;
  points: number;
  coins: number;
  reward: number | null;
}
export interface MissionWire {
  tag: string;
  category: string;
  own: boolean;
  friends: readonly string[];
  completedAt: string | null;
}
export interface GameWire {
  version: number;
  me: PlayerWire;
  checkedIn: boolean;
  badgeUid: string | null;
  earlyClaimed: boolean;
  tutorialSeen: boolean;
  role: AccountRole;
  boothId: string | null;
  phase: EventPhase;
  hand: readonly number[];
  coins: number;
  points: number;
  packs: number;
  peekCards: number;
  planets: readonly number[];
  planetDates: Readonly<Record<string, string>>;
  missions: readonly MissionWire[];
  checkpoints: readonly { number: number; area: string; collectedAt: string | null; hint: MessageWire | null }[];
  friends: readonly PlayerWire[];
  friendMethods: Readonly<Record<string, string>>;
  demoPlayers: readonly PlayerWire[];
  booths: readonly BoothWire[];
  stations: readonly StationWire[];
  ledger: readonly LedgerWire[];
  history: readonly BattleRecordWire[];
  battle: BattleWire | null;
  cooldownUntil: string | null;
  hintCredits: number;
  hintRemainder: number;
  randomEggPrice: number;
  seriesEggPrice: number;
  parameters: Readonly<Record<string, number>>;
  battleBlocked: Readonly<Record<string, MessageWire | null>>;
  unknownBattleBlocked: MessageWire | null;
  rankings: Readonly<Record<string, readonly { player: PlayerWire; value: number }[]>>;
}

export function playerToWire(p: PlayerCard): PlayerWire {
  return { id: p.id, name: p.name, tags: p.tags, contact: p.contact, planet: p.planet, style: p.style, roles: p.roles };
}
export const playerFromWire = (p: PlayerWire) => new PlayerCard(p);

export function boothToWire(b: Booth): BoothWire {
  return { id: b.id, name: b.name, url: b.url, visited: b.visited, completed: b.completed };
}
export const boothFromWire = (b: BoothWire) => new Booth(b);

export function stationToWire(s: Station): StationWire {
  return { id: s.id, name: s.name, packs: s.packs, limit: s.limit, remaining: s.remaining, open: s.open };
}
export const stationFromWire = (s: StationWire) => new Station(s);

export function battleToWire(b: Battle): BattleWire {
  return {
    id: b.id, opponent: playerToWire(b.opponent), deadline: stamp(b.deadline),
    accepted: b.accepted, finished: b.finished, peekUsed: b.peekUsed, opponentHand: b.opponentHand,
    rounds: b.rounds.map(r => ({
      mine: cardIndex(r.mine), opponent: cardIndex(r.opponent), outcome: r.outcome, automatic: r.automatic, wild: r.wild,
    })),
  };
}
export function battleFromWire(b: BattleWire): Battle {
  return new Battle({ ...b, opponent: playerFromWire(b.opponent), deadline: parseDate(b.deadline),
    rounds: b.rounds.map(r => new RoundResult(handCards[r.mine], handCards[r.opponent], r.outcome, r)),
  });
}

export function scanToWire(r: ScanResult): ScanWire {
  return {
    kind: r.kind, message: r.message.toJson(), uid: r.uid,
    player: r.player == null ? null : playerToWire(r.player),
    booth: r.booth == null ? null : boothToWire(r.booth),
    station: r.station == null ? null : stationToWire(r.station),
    targetPlayerId: r.targetPlayerId, repeated: r.repeated, openPacks: r.openPacks,
  };
}
export function scanFromWire(r: ScanWire): ScanResult {
  return new ScanResult(r.kind, GameMessage.fromJson(r.message), {
    uid: r.uid, player: r.player == null ? null : playerFromWire(r.player),
    booth: r.booth == null ? null : boothFromWire(r.booth),
    station: r.station == null ? null : stationFromWire(r.station),
    targetPlayerId: r.targetPlayerId, repeated: r.repeated, openPacks: r.openPacks,
  });
}

export const hatchToWire = (r: HatchResult): HatchWire => ({ planet: r.planet, seriesCompleted: r.seriesCompleted });
export const hatchFromWire = (r: HatchWire) => new HatchResult(r.planet, r.seriesCompleted);

export function gameToWire(g: GameView): GameWire {
  const demoPlayers = g.demoPlayers;
  const battle = g.battle;
  const cooldown = g.cooldownUntil;
  return {
    version: gameWireVersion,
    me: playerToWire(g.me),
    badgeUid: g.badgeUid,
    checkedIn: g.checkedIn, earlyClaimed: g.earlyClaimed, tutorialSeen: g.tutorialSeen,
    role: g.role, boothId: g.boothId, phase: g.phase,
    hand: g.hand, coins: g.coins, points: g.points, packs: g.packs, peekCards: g.peekCards,
    planets: [...g.planets],
    planetDates: Object.fromEntries([...g.planetDates].map(([k, v]) => [k, stamp(v)])),
    missions: g.missions.map(m => ({
      tag: m.tag, category: m.category, own: m.own, friends: m.friends,
      completedAt: m.completedAt == null ? null : stamp(m.completedAt),
    })),
    checkpoints: g.checkpoints.map(c => ({
      number: c.number, area: c.area,
      collectedAt: c.collectedAt == null ? null : stamp(c.collectedAt), hint: c.hint?.toJson() ?? null,
    })),
    friends: g.friends.map(playerToWire), friendMethods: g.friendMethods,
    demoPlayers: demoPlayers.map(playerToWire), booths: g.booths.map(boothToWire), stations: g.stations.map(stationToWire),
    ledger: g.ledger.map(l => ({ at: stamp(l.at), reason: l.reason, detail: l.detail, coins: l.coins, args: l.args })),
    history: g.history.map(h => ({
      battle: battleToWire(h.battle), at: stamp(h.at), points: h.points, coins: h.coins,
      reward: h.reward == null ? null : cardIndex(h.reward),
    })),
    battle: battle == null ? null : battleToWire(battle), cooldownUntil: cooldown == null ? null : stamp(cooldown),
    hintCredits: g.hintCredits, hintRemainder: g.hintRemainder,
    randomEggPrice: g.randomEggPrice, seriesEggPrice: g.seriesEggPrice, parameters: g.parameters,
    battleBlocked: Object.fromEntries(demoPlayers.map(p => [p.id, g.battleBlocked(p)?.toJson() ?? null])),
    unknownBattleBlocked: g.battleBlocked(new PlayerCard({ id: '', name: '', tags: [] }))?.toJson() ?? null,
    rankings: Object.fromEntries(rankingMetrics.map(metric => [metric, g.ranking(metric).map(r => ({
      player: playerToWire(r.player), value: r.value,
    }))])),
  };
}

function message(value: MessageWire | null): GameMessage | null {
  return value == null ? null : GameMessage.fromJson(value);
}

/** Decoded view with no local mutations, clock, or game engine. */
export class GameSnapshot implements GameView {
  readonly me: PlayerCard;
  readonly checkedIn: boolean;
  readonly earlyClaimed: boolean;
  readonly tutorialSeen: boolean;
  readonly role: AccountRole;
  readonly boothId: string | null;
  readonly badgeUid: string | null;
  readonly phase: EventPhase;
  readonly hand: readonly number[];
  readonly coins: number;
  readonly points: number;
  readonly packs: number;
  readonly peekCards: number;
  readonly hintCredits: number;
  readonly hintRemainder: number;
  readonly randomEggPrice: number;
  readonly seriesEggPrice: number;
  readonly parameters: Readonly<Record<string, number>>;
  readonly planets: ReadonlySet<number>;
  readonly planetDates: ReadonlyMap<number, Date>;
  readonly missions: readonly Mission[];
  readonly checkpoints: readonly Checkpoint[];
  readonly friends: readonly PlayerCard[];
  readonly demoPlayers: readonly PlayerCard[];
  readonly friendMethods: Readonly<Record<string, string>>;
  readonly booths: readonly Booth[];
  readonly stations: readonly Station[];
  readonly ledger: readonly LedgerEntry[];
  readonly history: readonly BattleRecord[];
  readonly battle: Battle | null;
  readonly cooldownUntil: Date | null;
  #battleBlocked: Map<string, GameMessage | null>;
  #unknownBattleBlocked: GameMessage | null;
  #rankings: Map<string, readonly RankEntry[]>;

  static fromJson(json: GameWire) { return new GameSnapshot(json); }

  private constructor(json: GameWire) {
    if (json.version !== gameWireVersion) throw new GameStateError(new GameMessage('wireVersion'));
    this.me = playerFromWire(json.me);
    this.checkedIn = json.checkedIn;
    this.badgeUid = json.badgeUid;
    this.earlyClaimed = json.earlyClaimed;
    this.tutorialSeen = json.tutorialSeen;
    this.role = json.role;
    this.boothId = json.boothId;
    this.phase = json.phase;
    this.hand = Object.freeze([...json.hand]);
    this.coins = json.coins;
    this.points = json.points;
    this.packs = json.packs;
    this.peekCards = json.peekCards;
    this.planets = new Set(json.planets);
    this.planetDates = new Map(Object.entries(json.planetDates).map(([k, v]) => [Number(k), parseDate(v)]));
    this.missions = Object.freeze(json.missions.map(m => new Mission({ ...m, completedAt: optionalDate(m.completedAt) })));
    this.checkpoints = Object.freeze(json.checkpoints.map(c => new Checkpoint({ ...c, collectedAt: optionalDate(c.collectedAt), hint: message(c.hint) })));
    this.friends = Object.freeze(json.friends.map(playerFromWire));
    this.friendMethods = Object.freeze({ ...json.friendMethods });
    this.demoPlayers = Object.freeze(json.demoPlayers.map(playerFromWire));
    this.booths = Object.freeze(json.booths.map(boothFromWire));
    this.stations = Object.freeze(json.stations.map(stationFromWire));
    this.ledger = Object.freeze(json.ledger.map(l => new LedgerEntry(parseDate(l.at), l.reason, l.detail, l)));
    this.history = Object.freeze(json.history.map(h => new BattleRecord(
      battleFromWire(h.battle), parseDate(h.at), h.points, h.coins, h.reward == null ? null : handCards[h.reward],
    )));
    this.battle = json.battle == null ? null : battleFromWire(json.battle);
    this.cooldownUntil = optionalDate(json.cooldownUntil);
    this.hintCredits = json.hintCredits;
    this.hintRemainder = json.hintRemainder;
    this.randomEggPrice = json.randomEggPrice;
    this.seriesEggPrice = json.seriesEggPrice;
    this.parameters = Object.freeze({ ...json.parameters });
    this.#battleBlocked = new Map(Object.entries(json.battleBlocked).map(([id, value]) => [id, message(value)]));
    this.#unknownBattleBlocked = message(json.unknownBattleBlocked);
    this.#rankings = new Map(Object.entries(json.rankings).map(([metric, ranks]) => [
      metric, Object.freeze(ranks.map(r => new RankEntry(playerFromWire(r.player), r.value))),
    ]));
  }

  battleBlocked(p: PlayerCard) {
    return this.#battleBlocked.has(p.id) ? this.#battleBlocked.get(p.id)! : this.#unknownBattleBlocked;
  }

  ranking(metric: string) {
    const ranks = this.#rankings.get(metric);
    if (!ranks) throw new GameArgumentError(new GameMessage('unknownRanking', { metric }));
    return ranks;
  }
}
