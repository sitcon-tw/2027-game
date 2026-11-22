import { fixtureStations } from './fixtures.ts';
import { GameMessage, GameStateError, eventPhases } from './service.ts';
import type { AccountRole, EventPhase, MessageWire, ScannerMode } from './service.ts';
import type { BattleRecordWire, BattleWire, LedgerWire, MissionWire, PrivatePlayerWire, ScanWire, StationWire } from './wire.ts';

export type SavedBattle = BattleWire<PrivatePlayerWire>;
export interface SavedScan extends Omit<ScanWire<PrivatePlayerWire>, 'message' | 'repeated'> {
  source: string;
  mode?: ScannerMode;
  assignedBooth: string | null;
  message?: MessageWire;
  repeated?: boolean;
}

export interface BoothProgress {
  boothVisited: string[];
  boothCompleted: string[];
  hintCredits: number;
  hintRemainder: number;
}

export interface GameState extends BoothProgress {
  version: number;
  name: string;
  tags: string[];
  contact: string;
  badge: string | null;
  checkedIn: boolean;
  early: boolean;
  earlyUnlocked: boolean;
  tutorial: boolean;
  role: AccountRole;
  boothId: string | null;
  recipients: Record<string, BoothProgress>;
  phase: number;
  hand: number[];
  coins: number;
  points: number;
  packs: number;
  peek: number;
  planets: Record<string, string>;
  seriesRewards: number[];
  planet: number | null;
  style: number;
  missions: Omit<MissionWire, 'friends'>[];
  players: PrivatePlayerWire[];
  friends: Record<string, string>;
  checkpoints: Record<string, string>;
  hints: Record<string, MessageWire>;
  stationClaims: Record<string, number>;
  stationStock: Record<string, number>;
  stationConfigs: Record<string, Omit<StationWire, 'id' | 'remaining'>>;
  bindings: Record<string, string>;
  ledger: LedgerWire[];
  history: BattleRecordWire<PrivatePlayerWire>[];
  battle: SavedBattle | null;
  cooldown: string | null;
  bag: number[];
  scans: Record<string, SavedScan>;
  agenda: string[];
  deliveries: Record<string, { amount: number; reason: string }>;
  photo: boolean;
  sequence: number;
  opponentHands: Record<string, number[]>;
  parameters?: Record<string, number>;
  attendeeScans?: Record<string, string>;
  attendeeFriends?: Record<string, PrivatePlayerWire>;
}

export function freshState(name: string, phase: EventPhase): GameState {
  return {
    version: 1, name, tags: [], contact: '', badge: null, checkedIn: false, early: false,
    earlyUnlocked: false, tutorial: false, role: 'user', boothId: null, recipients: {},
    phase: eventPhases.indexOf(phase), hand: [0, 0, 0, 0], coins: 0, points: 0, packs: 0, peek: 0,
    planets: {}, seriesRewards: [], planet: null, style: -1, missions: [], players: [], friends: Object.create(null),
    checkpoints: {}, hints: {}, boothVisited: [], boothCompleted: [], stationClaims: {},
    stationStock: Object.fromEntries(Object.entries(fixtureStations).map(([id, station]) => [id, station.remaining])),
    stationConfigs: {}, bindings: {}, ledger: [], history: [], battle: null, cooldown: null,
    hintCredits: 0, hintRemainder: 0, bag: [], scans: Object.create(null), agenda: [], deliveries: Object.create(null),
    photo: false, sequence: 0, opponentHands: {},
  };
}

export function decodeState(raw: string): GameState {
  let state: GameState & { staff?: boolean };
  try {
    state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError();
  } catch {
    throw new GameStateError(new GameMessage('corruptSave'));
  }
  if (state.version !== 1) throw new GameStateError(new GameMessage('unsupportedSave'));
  if (!Object.hasOwn(state, 'role')) state.role = state.staff === true ? 'staff' : 'user';
  delete state.staff;
  if (!Object.hasOwn(state, 'stationConfigs')) state.stationConfigs = {};
  if (!Object.hasOwn(state, 'boothId')) state.boothId = null;
  if (!Object.hasOwn(state, 'recipients')) state.recipients = {};
  // These keys come from users rather than closed fixture namespaces.
  Object.setPrototypeOf(state.friends, null);
  Object.setPrototypeOf(state.scans, null);
  Object.setPrototypeOf(state.deliveries, null);
  if (state.attendeeScans) Object.setPrototypeOf(state.attendeeScans, null);
  if (state.attendeeFriends) Object.setPrototypeOf(state.attendeeFriends, null);
  return state;
}
