export interface MessageWire {
  code: string;
  args: Readonly<Record<string, unknown>>;
}

export class GameMessage {
  readonly code: string;
  readonly args: Readonly<Record<string, unknown>>;

  constructor(code: string, args: Readonly<Record<string, unknown>> = {}) {
    this.code = code;
    this.args = Object.freeze({ ...args });
  }

  static fromJson(json: { code: string; args?: Record<string, unknown> | null }): GameMessage {
    return new GameMessage(json.code, json.args ?? {});
  }

  toJson(): MessageWire {
    return { code: this.code, args: this.args };
  }

  equals(other: unknown): boolean {
    return other instanceof GameMessage && this.code === other.code &&
      Object.keys(this.args).length === Object.keys(other.args).length &&
      Object.entries(this.args).every(([key, value]) => Object.hasOwn(other.args, key) && other.args[key] === value);
  }
}

export interface GameLocalizedError extends Error {
  readonly localizedMessage: GameMessage;
}

export class GameStateError extends Error implements GameLocalizedError {
  readonly localizedMessage: GameMessage;

  constructor(localizedMessage: GameMessage) {
    super(localizedMessage.code);
    this.name = 'GameStateError';
    this.localizedMessage = localizedMessage;
  }
}

export class GameArgumentError extends Error implements GameLocalizedError {
  readonly localizedMessage: GameMessage;

  constructor(localizedMessage: GameMessage) {
    super(localizedMessage.code);
    this.name = 'GameArgumentError';
    this.localizedMessage = localizedMessage;
  }
}

export const HandCard = Object.freeze({ scissors: 'scissors', rock: 'rock', paper: 'paper', wild: 'wild' } as const);
export type HandCard = typeof HandCard[keyof typeof HandCard];
export const handCards = Object.freeze(Object.values(HandCard));
export const cardIndex = (card: HandCard) => handCards.indexOf(card);

export const EventPhase = Object.freeze({ before: 'before', active: 'active', ended: 'ended' } as const);
export type EventPhase = typeof EventPhase[keyof typeof EventPhase];
export const eventPhases = Object.freeze(Object.values(EventPhase));

export const AccountRole = Object.freeze({ user: 'user', staff: 'staff', booth: 'booth' } as const);
export type AccountRole = typeof AccountRole[keyof typeof AccountRole];
export const ScannerMode = Object.freeze({ user: 'user', staff: 'staff', booth: 'booth' } as const);
export type ScannerMode = typeof ScannerMode[keyof typeof ScannerMode];

export const cardNames = ['剪刀', '石頭', '布', '萬用卡'] as const;
export const seriesNames = ['太陽', '地球', '水星', '火星', '土星', '月球'] as const;
export const colorNames = ['綠', '粉', '橘', '黃', '淺藍', '深藍', '紫'] as const;
export const hashtagOptions: Readonly<Record<string, readonly string[]>> = {
  技術: ['AI', '資安', 'CTF', '網頁前端', '後端', 'App開發', '遊戲開發', '物聯網', '區塊鏈', 'UI/UX', '競程', '各種程式語言'],
  派系: ['Vim派', 'VSCode派', 'Tab派', '空格派', '深色模式派', '貓派', '狗派', '咖哩不拌', '咖哩拌爆', '香菜是邪教', '火鍋加芋頭'],
  興趣: ['夜貓族', '咖啡續命', '手搖飲', '動漫', '電玩', '桌遊', '運動', '音樂', '攝影', '創客'],
};
export const opposingTags = [['Vim派', 'VSCode派'], ['Tab派', '空格派'], ['貓派', '狗派'], ['咖哩不拌', '咖哩拌爆']] as const;

export class PlayerCard {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly contact: string;
  readonly planet: number | null;
  readonly style: number;
  readonly roles: readonly string[];

  constructor({ id, name, tags, contact = '', planet = null, style = -1, roles = ['會眾'] }: {
    id: string; name: string; tags: readonly string[]; contact?: string;
    planet?: number | null; style?: number; roles?: readonly string[];
  }) {
    this.id = id;
    this.name = name;
    this.tags = Object.freeze([...tags]);
    this.contact = contact;
    this.planet = planet;
    this.style = style;
    this.roles = Object.freeze([...roles]);
  }
}

export class Mission {
  readonly tag: string;
  readonly category: string;
  readonly own: boolean;
  readonly friends: readonly string[];
  readonly completedAt: Date | null;

  constructor({ tag, category, own, friends, completedAt = null }: {
    tag: string; category: string; own: boolean; friends: readonly string[]; completedAt?: Date | null;
  }) {
    this.tag = tag;
    this.category = category;
    this.own = own;
    this.friends = Object.freeze([...friends]);
    this.completedAt = completedAt;
  }

  get progress() { return Math.min(this.friends.length, 3); }
}

export class Checkpoint {
  readonly number: number;
  readonly area: string;
  readonly collectedAt: Date | null;
  readonly hint: GameMessage | null;

  constructor({ number, area, collectedAt = null, hint = null }: {
    number: number; area: string; collectedAt?: Date | null; hint?: GameMessage | null;
  }) {
    this.number = number;
    this.area = area;
    this.collectedAt = collectedAt;
    this.hint = hint;
  }
}

export class Booth {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly visited: boolean;
  readonly completed: boolean;

  constructor({ id, name, url, visited = false, completed = false }: {
    id: string; name: string; url: string; visited?: boolean; completed?: boolean;
  }) {
    this.id = id;
    this.name = name;
    this.url = url;
    this.visited = visited;
    this.completed = completed;
  }
}

export class Station {
  readonly id: string;
  readonly name: string;
  readonly packs: number;
  readonly limit: number;
  readonly remaining: number;
  readonly open: boolean;

  constructor({ id, name, packs = 1, limit = 1, remaining = 100, open = true }: {
    id: string; name: string; packs?: number; limit?: number; remaining?: number; open?: boolean;
  }) {
    this.id = id;
    this.name = name;
    this.packs = packs;
    this.limit = limit;
    this.remaining = remaining;
    this.open = open;
  }
}

export class LedgerEntry {
  readonly at: Date;
  readonly reason: string;
  readonly detail: string;
  readonly coins: number;
  readonly args: Readonly<Record<string, unknown>>;

  constructor(at: Date, reason: string, detail: string, { coins = 0, args = {} }: {
    coins?: number; args?: Readonly<Record<string, unknown>>;
  } = {}) {
    this.at = at;
    this.reason = reason;
    this.detail = detail;
    this.coins = coins;
    this.args = Object.freeze({ ...args });
  }

  get message() { return new GameMessage(`ledger.${this.reason}`, { ...this.args, coins: this.coins }); }
}

export class RoundResult {
  readonly mine: HandCard;
  readonly opponent: HandCard;
  readonly outcome: number;
  readonly automatic: boolean;
  readonly wild: boolean;

  constructor(mine: HandCard, opponent: HandCard, outcome: number, { automatic = false, wild = false } = {}) {
    this.mine = mine;
    this.opponent = opponent;
    this.outcome = outcome;
    this.automatic = automatic;
    this.wild = wild;
  }
}

export class Battle {
  readonly id: string;
  readonly opponent: PlayerCard;
  readonly deadline: Date;
  readonly accepted: boolean;
  readonly rounds: readonly RoundResult[];
  readonly finished: boolean;
  readonly peekUsed: boolean;
  readonly opponentHand: readonly number[];

  constructor({ id, opponent, deadline, accepted = false, rounds = [], finished = false, peekUsed = false, opponentHand = [4, 4, 4, 0] }: {
    id: string; opponent: PlayerCard; deadline: Date; accepted?: boolean; rounds?: readonly RoundResult[];
    finished?: boolean; peekUsed?: boolean; opponentHand?: readonly number[];
  }) {
    this.id = id;
    this.opponent = opponent;
    this.deadline = deadline;
    this.accepted = accepted;
    this.rounds = Object.freeze([...rounds]);
    this.finished = finished;
    this.peekUsed = peekUsed;
    this.opponentHand = Object.freeze([...opponentHand]);
  }

  get wins() { return this.rounds.reduce((n, r) => n + Number(r.outcome > 0), 0); }
  get losses() { return this.rounds.reduce((n, r) => n + Number(r.outcome < 0), 0); }
  get result() { return Math.sign(this.wins - this.losses); }
}

export class BattleRecord {
  readonly battle: Battle;
  readonly at: Date;
  readonly points: number;
  readonly coins: number;
  readonly reward: HandCard | null;

  constructor(battle: Battle, at: Date, points: number, coins: number, reward: HandCard | null) {
    this.battle = battle;
    this.at = at;
    this.points = points;
    this.coins = coins;
    this.reward = reward;
  }
}

export class RankEntry {
  readonly player: PlayerCard;
  readonly value: number;

  constructor(player: PlayerCard, value: number) {
    this.player = player;
    this.value = value;
  }
}

export class ScanResult {
  readonly kind: string;
  readonly message: GameMessage;
  readonly player: PlayerCard | null;
  readonly booth: Booth | null;
  readonly uid: string | null;
  readonly openPacks: boolean;
  readonly station: Station | null;
  readonly targetPlayerId: string | null;
  readonly repeated: boolean;

  constructor(kind: string, message: GameMessage,
    { player = null, booth = null, uid = null, openPacks = false, station = null, targetPlayerId = null, repeated = false }: {
      player?: PlayerCard | null; booth?: Booth | null; uid?: string | null; openPacks?: boolean;
      station?: Station | null; targetPlayerId?: string | null; repeated?: boolean;
    } = {}) {
    this.kind = kind;
    this.message = message;
    this.player = player;
    this.booth = booth;
    this.uid = uid;
    this.openPacks = openPacks;
    this.station = station;
    this.targetPlayerId = targetPlayerId;
    this.repeated = repeated;
  }
}

export class HatchResult {
  readonly planet: number;
  readonly seriesCompleted: boolean;

  constructor(planet: number, seriesCompleted: boolean) {
    this.planet = planet;
    this.seriesCompleted = seriesCompleted;
  }
}

export interface GameView {
  readonly parameters: Readonly<Record<string, number>>;
  readonly me: PlayerCard;
  readonly checkedIn: boolean;
  readonly badgeUid: string | null;
  readonly earlyClaimed: boolean;
  readonly tutorialSeen: boolean;
  readonly role: AccountRole;
  readonly boothId: string | null;
  readonly phase: EventPhase;
  readonly hand: readonly number[];
  readonly coins: number;
  readonly points: number;
  readonly packs: number;
  readonly peekCards: number;
  readonly planets: ReadonlySet<number>;
  readonly planetDates: ReadonlyMap<number, Date>;
  readonly missions: readonly Mission[];
  readonly checkpoints: readonly Checkpoint[];
  readonly friends: readonly PlayerCard[];
  readonly friendMethods: Readonly<Record<string, string>>;
  readonly demoPlayers: readonly PlayerCard[];
  readonly booths: readonly Booth[];
  readonly stations: readonly Station[];
  readonly ledger: readonly LedgerEntry[];
  readonly history: readonly BattleRecord[];
  readonly battle: Battle | null;
  readonly cooldownUntil: Date | null;
  readonly hintCredits: number;
  readonly hintRemainder: number;
  readonly randomEggPrice: number;
  readonly seriesEggPrice: number;
  battleBlocked(player: PlayerCard): GameMessage | null;
  ranking(metric: string): readonly RankEntry[];
}

export interface GameService extends GameView {
  readonly now: Date;
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
  dispose(): void;
  initialize(): Promise<void>;
  bindBadge(uid: string): Promise<void>;
  saveProfile(tags: readonly string[], contact: string, options?: { nickname?: string | null }): Promise<void>;
  finishTutorial(): Promise<void>;
  claimEarly(): Promise<void>;
  scan(uid: string, scanId: string, options?: { mode?: ScannerMode }): Promise<ScanResult>;
  requestFriend(playerId: string): Promise<void>;
  simulateReciprocalScan(playerId: string): Promise<void>;
  inviteBattle(playerId: string): Promise<void>;
  cancelBattle(): Promise<void>;
  playCard(card: HandCard, options?: { asCard?: HandCard | null }): Promise<void>;
  usePeek(): Promise<void>;
  tick(): Promise<void>;
  openPacks(options?: { all?: boolean }): Promise<readonly HandCard[]>;
  buyEgg(options?: { series?: number | null }): Promise<HatchResult>;
  selectAppearance(planet: number | null, style: number): Promise<void>;
  redeemHint(): Promise<GameMessage>;
  bindStation(uid: string, stationId: string): Promise<void>;
}
