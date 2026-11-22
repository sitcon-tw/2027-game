import {
  AccountRole, Battle, BattleRecord, Booth, Checkpoint, EventPhase, GameArgumentError, GameMessage,
  GameStateError, HatchResult, HandCard, LedgerEntry, Mission, PlayerCard, RankEntry, RoundResult,
  ScannerMode, ScanResult, Station, cardIndex, cardNames, eventPhases, handCards, hashtagOptions,
  opposingTags, seriesNames,
} from './service.ts';
import type { GameService } from './service.ts';
import {
  attendeeByUid, boothByUid, boothNames, boothUid, checkpointAreaByIndex, checkpointByUid, checkpointUid,
  checkpointNumberForTarget,
  fixturePlayer, fixtureStations, operatorAttendees, playerUid, selfUid, stationByUid, stationUid, unknownUid,
} from './fixtures.ts';
import { addSeconds, isBefore, optionalDate, parseDate, stamp } from './time.ts';
import { decodeState, freshState } from './state.ts';
import type { BoothProgress, GameState, SavedBattle, SavedScan } from './state.ts';
import { boothFromWire, boothToWire, stationFromWire, stationToWire } from './wire.ts';
import type { PrivatePlayerWire } from './wire.ts';

export * from './service.ts';
export * from './wire.ts';

/** A single JSON document is the commit boundary for each game mutation. */
export interface GameStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface GameRandom {
  nextInt(max: number): number;
}

export interface GameEngineOptions {
  storage: GameStorage;
  clock?: () => Date;
  random?: GameRandom;
  importedNickname?: string;
  initialPhase?: EventPhase;
}

type LogOptions = { coins?: number; at?: Date; args?: Readonly<Record<string, unknown>> };
const tagCategories = Object.entries(hashtagOptions);
const validTags = new Set(Object.values(hashtagOptions).flat());
const accountRoles = new Set<string>(Object.values(AccountRole));
const totalCards = (cards: readonly number[]) => cards.reduce((sum, n) => sum + n, 0);
const displayHand = (cards: readonly number[]) => `[${cards.join(', ')}]`;

function playerJson(p: PlayerCard): PrivatePlayerWire {
  return { id: p.id, name: p.name, tags: p.tags, contact: p.contact, planet: p.planet, style: p.style };
}

function playerFromSaved({ id, name, tags, contact, planet, style }: PrivatePlayerWire): PlayerCard {
  return new PlayerCard({ id, name, tags, contact: contact ?? '', planet: planet ?? null, style: style ?? -1 });
}

function battleJson(b: Battle): SavedBattle {
  return {
    id: b.id, opponent: playerJson(b.opponent), deadline: stamp(b.deadline), accepted: b.accepted,
    finished: b.finished, peekUsed: b.peekUsed, opponentHand: b.opponentHand,
    rounds: b.rounds.map(r => ({
      mine: cardIndex(r.mine), opponent: cardIndex(r.opponent), outcome: r.outcome, automatic: r.automatic, wild: r.wild,
    })),
  };
}

function battleFrom(b: SavedBattle): Battle {
  return new Battle({ ...b, opponent: playerFromSaved(b.opponent), deadline: parseDate(b.deadline),
    rounds: b.rounds.map(r => new RoundResult(handCards[r.mine], handCards[r.opponent], r.outcome, r)),
  });
}

function scanFrom(r: SavedScan): ScanResult {
  const message = r.message != null && typeof r.message === 'object' && !Array.isArray(r.message)
    ? GameMessage.fromJson(r.message) : new GameMessage(`scan.${r.kind}`);
  return new ScanResult(r.kind, message, {
    uid: r.uid, player: r.player == null ? null : playerFromSaved(r.player), openPacks: r.openPacks,
    targetPlayerId: r.targetPlayerId, repeated: r.repeated ?? false,
    station: r.station == null ? null : stationFromWire(r.station), booth: r.booth == null ? null : boothFromWire(r.booth),
  });
}

export class GameEngine implements GameService {
  static readonly defaultParameters = Object.freeze({
    randomEggPrice: 10, seriesEggPrice: 40, hintThreshold: 2, missionCoins: 12, agendaPacks: 1,
    battleWinCoins: 30, battleDrawCoins: 10, battleCooldownSeconds: 60,
  });
  static readonly selfUid = selfUid;
  static readonly unknownUid = unknownUid;
  static readonly playerUid = playerUid;
  static readonly checkpointUid = checkpointUid;
  static readonly boothUid = boothUid;
  static readonly stationUid = stationUid;

  static normalizeUid(value: string): string {
    const uid = value.replace(/[\s:-]/g, '').toUpperCase();
    if (!/^[0-9A-F]{14}$/.test(uid)) throw new GameArgumentError(new GameMessage('invalidUid'));
    return uid;
  }

  readonly storage: GameStorage;
  readonly importedNickname: string;
  readonly initialPhase: EventPhase;
  readonly #clock: () => Date;
  readonly #random: GameRandom;
  #s!: GameState;
  #saved = '{}';
  #initializing?: Promise<void>;
  #tail = Promise.resolve();
  #listeners: (() => void)[] = [];
  // Face-to-face intent is transient, not a persistent inbox.
  #friendRequests = new Map<string, Date>();
  #scannedPlayers = new Set<string>();
  #globalBindings?: Readonly<Record<string, string>>;
  #bindingConflicts = new Set<string>();

  constructor({ storage, clock = () => new Date(), random = { nextInt: max => Math.floor(Math.random() * max) },
    importedNickname = 'OPass 模擬會眾', initialPhase = EventPhase.before }: GameEngineOptions) {
    this.storage = storage;
    this.#clock = clock;
    this.#random = random;
    this.importedNickname = importedNickname;
    this.initialPhase = initialPhase;
  }

  get now() { return this.#clock(); }
  exportState() { return this.#s == null ? '{}' : JSON.stringify(this.#s); }

  addListener(listener: () => void) { this.#listeners.push(listener); }
  removeListener(listener: () => void) {
    const i = this.#listeners.indexOf(listener);
    if (i !== -1) this.#listeners.splice(i, 1);
  }
  notifyListeners() {
    for (const listener of this.#listeners.slice()) {
      if (this.#listeners.includes(listener)) listener();
    }
  }
  dispose() { this.#listeners.length = 0; }

  /** Server-owned overlay; independent saved fixture bindings are retained. */
  useGlobalBindings(bindings: Readonly<Record<string, string>>, { conflicts = new Set<string>() }: {
    conflicts?: ReadonlySet<string>;
  } = {}) {
    this.#globalBindings = { ...bindings };
    this.#bindingConflicts = new Set(conflicts);
  }

  initialize(): Promise<void> { return this.#initializing ??= this.#load(); }

  async #load() {
    let raw: string | null;
    try {
      raw = await this.storage.read();
    } catch (error) {
      if (error instanceof Error && 'localizedMessage' in error) throw error;
      throw new GameStateError(new GameMessage('storageFailure'));
    }
    this.#s = raw == null ? freshState(this.importedNickname, this.initialPhase) : decodeState(raw);
    if (!accountRoles.has(this.role) ||
        (this.role === AccountRole.booth && !this.booths.some(b => b.id === this.boothId)) ||
        (this.role !== AccountRole.booth && this.boothId != null)) {
      throw new GameStateError(new GameMessage('corruptSave'));
    }
    this.#advanceExpired();
    this.#saved = this.exportState();
    await this.#writeState(this.#saved);
    this.notifyListeners();
  }

  async #writeState(value: string) {
    try {
      await this.storage.write(value);
    } catch (error) {
      if (error instanceof Error && 'localizedMessage' in error) throw error;
      throw new GameStateError(new GameMessage('storageFailure'));
    }
  }

  async #change<T>(action: () => T): Promise<T> {
    await this.initialize();
    const result = this.#tail.then(async () => {
      const pending = new Map(this.#friendRequests);
      const scanned = new Set(this.#scannedPlayers);
      try {
        const value = action();
        const saved = this.exportState();
        await this.#writeState(saved);
        this.notifyListeners();
        this.#saved = saved;
        return value;
      } catch (error) {
        this.#s = decodeState(this.#saved);
        this.#friendRequests = pending;
        this.#scannedPlayers = scanned;
        throw error;
      }
    });
    this.#tail = result.then(() => {}, () => {});
    return result;
  }

  #active() {
    if (this.phase !== EventPhase.active) throw new GameStateError(new GameMessage(this.phase === EventPhase.before ? 'eventBefore' : 'eventEnded'));
    if (!this.checkedIn) throw new GameStateError(new GameMessage('checkInRequired'));
  }

  #log(reason: string, detail: string, { coins = 0, at = this.now, args = {} }: LogOptions = {}) {
    const balance = this.coins + coins;
    if (balance < 0) throw new GameStateError(new GameMessage('insufficientCoins'));
    this.#s.coins = balance;
    this.#s.ledger.push({ at: stamp(at), reason, detail: `${detail}；金幣餘額 ${balance}`, args, coins });
  }

  get parameters(): Readonly<Record<string, number>> {
    return this.#s.parameters == null ? GameEngine.defaultParameters : Object.freeze({ ...this.#s.parameters });
  }
  get me() {
    const { name, tags, contact, planet, style } = this.#s;
    return new PlayerCard({ id: 'mock-opass-self', name, tags, contact, planet, style });
  }
  get checkedIn() { return this.#s.checkedIn; }
  get badgeUid() { return this.#s.badge; }
  get earlyClaimed() { return this.#s.early; }
  get tutorialSeen() { return this.#s.tutorial; }
  get role() { return this.#s.role; }
  get boothId() { return this.#s.boothId; }
  get phase() { return eventPhases[this.#s.phase]; }
  get hand() { return Object.freeze(this.#s.hand.slice()); }
  get coins() { return this.#s.coins; }
  get points() { return this.#s.points; }
  get packs() { return this.#s.packs; }
  get peekCards() { return this.#s.peek; }
  get planets() { return new Set(Object.keys(this.#s.planets).map(Number)); }
  get planetDates() { return new Map(Object.entries(this.#s.planets).map(([k, v]) => [Number(k), parseDate(v)])); }
  get missions() {
    const friends = this.friends;
    return Object.freeze(this.#s.missions.map(m => new Mission({
      ...m, friends: friends.filter(f => f.tags.includes(m.tag)).map(f => f.id), completedAt: optionalDate(m.completedAt),
    })));
  }
  get checkpoints() {
    return Object.freeze(checkpointAreaByIndex.map((area, i) => {
      const number = i + 1;
      return new Checkpoint({ number, area, collectedAt: optionalDate(this.#s.checkpoints[number]),
        hint: Object.hasOwn(this.#s.hints, number) ? new GameMessage('checkpointHint', { number, area }) : null,
      });
    }));
  }
  get demoPlayers(): readonly PlayerCard[] {
    if (!this.#s.players.length && this.role !== AccountRole.user) return operatorAttendees;
    return Object.freeze(this.#s.players.map(playerFromSaved));
  }
  #findPlayer(id: string): PlayerCard {
    const p = this.demoPlayers.find(p => p.id === id);
    if (!p) throw new GameArgumentError(new GameMessage('playerNotFound'));
    return p;
  }
  get friends() {
    return Object.freeze([
      ...this.demoPlayers.filter(p => Object.hasOwn(this.#s.friends, p.id)),
      ...Object.values(this.#s.attendeeFriends ?? {}).map(playerFromSaved),
    ]);
  }
  get friendMethods() { return Object.freeze({ ...this.#s.friends }); }
  get booths() {
    return Object.freeze(boothNames.map((name, i) => {
      const id = `booth-${i + 1}`;
      return new Booth({ id, name, url: 'https://sitcon.org/',
        visited: this.#s.boothVisited.includes(id), completed: this.#s.boothCompleted.includes(id),
      });
    }));
  }
  get stations() {
    return Object.freeze(Object.entries(this.#s.stationStock).map(([id, remaining]) => {
      const config = this.#s.stationConfigs[id];
      const fixture = fixtureStations[id as keyof typeof fixtureStations];
      return new Station({ id, name: config?.name ?? fixture?.name, remaining,
        packs: config?.packs ?? fixture?.packs, limit: config?.limit ?? fixture?.limit,
        open: config?.open ?? fixture?.open,
      });
    }));
  }
  get ledger() {
    return Object.freeze(this.#s.ledger.toReversed().map(l => new LedgerEntry(parseDate(l.at), l.reason, l.detail, l)));
  }
  get history() {
    return Object.freeze(this.#s.history.toReversed().map(h => new BattleRecord(
      battleFrom(h.battle), parseDate(h.at), h.points, h.coins, h.reward == null ? null : handCards[h.reward],
    )));
  }
  get battle() { return this.#s.battle == null ? null : battleFrom(this.#s.battle); }
  get cooldownUntil() { return optionalDate(this.#s.cooldown); }
  get hintCredits() { return this.#s.hintCredits; }
  get hintRemainder() { return this.#s.hintRemainder; }
  get randomEggPrice() { return this.parameters.randomEggPrice; }
  get seriesEggPrice() { return this.parameters.seriesEggPrice; }

  configureParameters(values: Readonly<Record<string, number>>) {
    return this.#change(() => {
      if (Object.keys(values).some(key => !Object.hasOwn(GameEngine.defaultParameters, key))) {
        throw new GameArgumentError(new GameMessage('unknownParameter'));
      }
      for (const [parameter, value] of Object.entries(values)) {
        const minimum = parameter === 'battleWinCoins' || parameter === 'battleDrawCoins' || parameter === 'missionCoins' ? 0 : 1;
        const maximum = parameter === 'agendaPacks' ? 3 : 3600;
        if (!Number.isInteger(value) || value < minimum || value > maximum) throw new GameArgumentError(new GameMessage('parameterRange', { parameter }));
      }
      this.#s.parameters = { ...this.parameters, ...values };
      this.#log('admin.parameters', `調整參數 ${JSON.stringify(values)}`);
    });
  }

  configureStation(station: Station) {
    return this.#change(() => {
      if (!/^station-[a-zA-Z0-9-]{1,40}$/.test(station.id) || !station.name.trim() || station.name.length > 120 ||
          !Number.isInteger(station.packs) || station.packs < 1 || station.packs > 100 ||
          !Number.isInteger(station.limit) || station.limit < 1 || station.limit > 100 ||
          !Number.isInteger(station.remaining) || station.remaining < 0 || station.remaining > 100000) {
        throw new GameArgumentError(new GameMessage('invalidStation'));
      }
      this.#s.stationConfigs[station.id] = { name: station.name.trim(), packs: station.packs, limit: station.limit, open: station.open };
      this.#s.stationStock[station.id] = station.remaining;
      this.#log('admin.station', `${station.id} ${station.name} 每次${station.packs}包 限${station.limit}次 剩${station.remaining} 開放${station.open}`);
    });
  }

  bindBadge(uid: string) {
    return this.#change(() => {
      if (this.phase !== EventPhase.active) throw new GameStateError(new GameMessage('badgePhase'));
      const normalized = this.#validateBadgeUid(uid);
      if (this.badgeUid != null && this.badgeUid !== normalized) throw new GameStateError(new GameMessage('badgeLocked'));
      this.#setBadge(normalized, 'badge.bind');
    });
  }

  /** Operator-only replacement; the player-facing GameService cannot call it. */
  replaceBadge(uid: string) {
    return this.#change(() => this.#setBadge(this.#validateBadgeUid(uid), 'badge.replace'));
  }

  #validateBadgeUid(uid: string) {
    const normalized = GameEngine.normalizeUid(uid);
    if (attendeeByUid.has(normalized)) throw new GameStateError(new GameMessage('badgeTaken'));
    if (checkpointByUid.has(normalized) || boothByUid.has(normalized) || stationByUid.has(normalized) ||
        Object.hasOwn(this.#s.bindings, normalized)) {
      throw new GameStateError(new GameMessage('notBadge'));
    }
    return normalized;
  }

  #setBadge(normalized: string, reason: string) {
    if (this.badgeUid === normalized) return;
    this.#s.badge = normalized;
    this.#log(reason, `名牌 UID=${normalized}`);
    this.#checkInIfReady();
  }

  #validateTags(tags: readonly string[]) {
    const chosen = new Set(tags);
    if (chosen.size !== tags.length || tags.some(tag => !validTags.has(tag))) throw new GameArgumentError(new GameMessage('invalidTags'));
    for (const [category, options] of tagCategories) {
      const count = options.reduce((n, tag) => n + Number(chosen.has(tag)), 0);
      if (count < 1 || count > 3) throw new GameArgumentError(new GameMessage('categoryTagCount', { category }));
    }
    for (const [first, second] of opposingTags) {
      if (chosen.has(first) && chosen.has(second)) throw new GameArgumentError(new GameMessage('opposingTags', { first, second }));
    }
  }

  saveProfile(tags: readonly string[], contact: string, { nickname }: { nickname?: string | null } = {}) {
    return this.#change(() => {
      const savedTags = this.#s.tags;
      if (!savedTags.length) {
        this.#validateTags(tags);
        this.#s.tags = [...tags];
      } else if (tags.length !== savedTags.length || !savedTags.every(tag => tags.includes(tag))) {
        throw new GameStateError(new GameMessage('profileTagsLocked'));
      }
      if (nickname != null) {
        const name = nickname.trim();
        if (!name) throw new GameArgumentError(new GameMessage('nicknameRequired'));
        this.#s.name = name;
      }
      if (contact.length > 1000) throw new GameArgumentError(new GameMessage('contactTooLong'));
      this.#s.contact = contact.trim();
      this.#log('profile.edit', `更新公開 Hashtag ${tags.join('、')}；聯絡資訊${this.#s.contact ? '已更新' : '留空'}`);
      this.#checkInIfReady();
      this.#recomputeMissions();
    });
  }

  #checkInIfReady() {
    if (this.phase !== EventPhase.active || this.checkedIn || this.badgeUid == null || !this.#s.tags.length) return;
    this.#validateTags(this.#s.tags);
    this.#s.checkedIn = true;
    for (let i = 0; i < 3; i++) this.#s.hand[i] += 4;
    for (const [category, options] of tagCategories) {
      const own = options.filter(tag => this.#s.tags.includes(tag));
      const other = options.filter(tag => !this.#s.tags.includes(tag));
      this.#s.missions.push(
        { tag: own[this.#random.nextInt(own.length)], category, own: true, completedAt: null },
        { tag: other[this.#random.nextInt(other.length)], category, own: false, completedAt: null },
      );
    }
    this.#generatePlayers();
    this.#log('checkin', '完成報到；起始牌 剪刀4／石頭4／布4；固定產生6個 Hashtag 任務');
    if (this.earlyClaimed && !this.#s.earlyUnlocked) {
      this.#s.earlyUnlocked = true;
      this.#s.packs++;
      const hatch = this.#hatch(null);
      this.#log('early.unlock', `早鳥解鎖：1包＋星球${hatch.planet}（不扣金幣）`);
    }
  }

  #generatePlayers() {
    // Three fixture people per mission: all six are reachable without all-tag opponents.
    let index = 0;
    for (const mission of this.#s.missions) {
      for (let copy = 0; copy < 3; copy++) {
        const tags = tagCategories.map(([category, options]) => category === mission.category
          ? mission.tag : options[(index + copy) % options.length]);
        const p = fixturePlayer(++index, tags);
        this.#s.players.push(playerJson(p));
        this.#s.opponentHands[p.id] = [4, 4, 4, 0];
      }
    }
  }

  finishTutorial() { return this.#change(() => { this.#s.tutorial = true; }); }

  claimEarly() {
    return this.#change(() => {
      if (this.earlyClaimed) return;
      if (this.phase !== EventPhase.before) throw new GameStateError(new GameMessage('earlyPhase'));
      this.#s.early = true;
      this.#log('early.claim', '已登記早鳥：1顆隨機蛋＋1包，報到前鎖定');
    });
  }

  #scanJson(r: ScanResult, source: string, mode: ScannerMode): SavedScan {
    return {
      source, mode, assignedBooth: mode === ScannerMode.booth ? this.boothId : null,
      kind: r.kind, message: r.message.toJson(), uid: r.uid,
      player: r.player == null ? null : playerJson(r.player),
      booth: r.booth == null ? null : boothToWire(r.booth),
      openPacks: r.openPacks, targetPlayerId: r.targetPlayerId, repeated: r.repeated,
      station: r.station == null ? null : stationToWire(r.station),
    };
  }

  /** Permission is checked before looking up a receipt, including after revocation. */
  requireScannerMode(mode: ScannerMode) {
    if ((mode === ScannerMode.staff && this.role !== AccountRole.staff) ||
        (mode === ScannerMode.booth && this.role !== AccountRole.booth)) {
      throw new GameStateError(new GameMessage('operatorPermission'));
    }
    if (mode !== ScannerMode.user && this.phase !== EventPhase.active) {
      throw new GameStateError(new GameMessage(this.phase === EventPhase.before ? 'eventBefore' : 'eventEnded'));
    }
    if (mode === ScannerMode.booth && !this.booths.some(b => b.id === this.boothId)) {
      throw new GameStateError(new GameMessage('boothAssignmentRequired'));
    }
  }

  /** Trusted server orchestration only; never a player action. */
  replayScan(uid: string, scanId: string, mode: ScannerMode) {
    this.requireScannerMode(mode);
    const normalized = GameEngine.normalizeUid(uid);
    if (!scanId.trim() || scanId.length > 160) throw new GameArgumentError(new GameMessage('scanIdRequired'));
    const previous = this.#s.scans[scanId];
    if (previous == null) return null;
    if (previous.source !== normalized || (previous.mode ?? ScannerMode.user) !== mode ||
        (mode === ScannerMode.booth && previous.assignedBooth !== this.boothId)) {
      throw new GameStateError(new GameMessage('scanIdConflict'));
    }
    return scanFrom(previous);
  }

  /** Saves an authoritative cross-account result in the actor's receipt journal. */
  recordResolvedScan(uid: string, scanId: string, mode: ScannerMode, result: ScanResult) {
    return this.#change(() => {
      const prior = this.replayScan(uid, scanId, mode);
      if (prior != null) return prior;
      const normalized = GameEngine.normalizeUid(uid);
      this.#s.scans[scanId] = this.#scanJson(result, normalized, mode);
      if (result.kind === 'attendee' && result.targetPlayerId != null) {
        const scans = this.#s.attendeeScans ??= Object.create(null);
        scans[result.targetPlayerId] = normalized;
      }
      this.#log(mode === ScannerMode.user ? 'scan.attendee' : 'scan.operator', `scanId=${scanId} UID=${normalized} ${mode}`,
        { args: { mode, targetPlayerId: result.targetPlayerId } });
      return result;
    });
  }

  scan(uid: string, scanId: string, { mode = ScannerMode.user }: { mode?: ScannerMode } = {}) {
    return this.#change(() => {
      const normalized = GameEngine.normalizeUid(uid);
      const previous = this.replayScan(normalized, scanId, mode);
      if (previous != null) {
        if (previous.player != null && previous.kind === 'player') this.#scannedPlayers.add(previous.player.id);
        return previous;
      }
      const result = mode === ScannerMode.user ? this.#scanNew(normalized, scanId) : this.#scanOperator(normalized, mode);
      if (mode !== ScannerMode.user) {
        this.#log('scan.operator', `scanId=${scanId} UID=${normalized} ${mode}`, { args: { mode, targetPlayerId: result.targetPlayerId } });
      }
      this.#s.scans[scanId] = this.#scanJson(result, normalized, mode);
      return result;
    });
  }

  #boundTagTarget(uid: string) {
    if (this.#bindingConflicts.has(uid)) throw new GameStateError(new GameMessage('ambiguousTag'));
    return (this.#globalBindings ?? this.#s.bindings)[uid];
  }

  #scanOperator(uid: string, mode: ScannerMode) {
    if (uid === this.badgeUid || (uid === selfUid && this.badgeUid == null)) throw new GameStateError(new GameMessage('operatorSelfScan'));
    const fixture = attendeeByUid.get(uid);
    if (fixture != null) {
      const player = this.demoPlayers.find(p => p.id === uid) ?? fixture;
      if (mode === ScannerMode.staff) {
        return new ScanResult('staffPlayer', new GameMessage('staffIdentity'), { uid, player, targetPlayerId: player.id });
      }
      const progress = this.#s.recipients[player.id] ??= { boothVisited: [], boothCompleted: [], hintCredits: 0, hintRemainder: 0 };
      const repeated = this.#completeBoothProgress(progress, this.boothId!);
      const current = this.booths.find(b => b.id === this.boothId)!;
      const booth = new Booth({ ...current, visited: true, completed: true });
      return new ScanResult('boothComplete', new GameMessage(repeated ? 'boothAlreadyComplete' : 'boothTaskComplete'),
        { uid, player, targetPlayerId: player.id, booth, repeated });
    }
    if (mode === ScannerMode.booth) throw new GameStateError(new GameMessage('attendeeBadgeRequired'));
    const target = this.#boundTagTarget(uid);
    const checkpoint = checkpointByUid.has(uid) || checkpointNumberForTarget(target) !== undefined;
    const stationId = stationByUid.get(uid) ?? (checkpoint ? undefined : target);
    if (stationId != null) {
      return new ScanResult('staffStation', new GameMessage('staffStationInfo'), { uid, station: this.#findStation(stationId) });
    }
    const known = checkpoint || boothByUid.has(uid);
    return new ScanResult(known ? 'operatorTag' : 'bindStation', new GameMessage(known ? 'operatorTagInfo' : 'scan.bindStation'), { uid });
  }

  #completeBoothProgress(progress: BoothProgress, id: string) {
    if (progress.boothCompleted.includes(id)) return true;
    progress.boothCompleted.push(id);
    if (!progress.boothVisited.includes(id)) progress.boothVisited.push(id);
    const total = progress.hintRemainder + 1;
    const threshold = (this.#s.parameters ?? GameEngine.defaultParameters).hintThreshold;
    progress.hintCredits += Math.trunc(total / threshold);
    progress.hintRemainder = total % threshold;
    return false;
  }

  /** Recipient-side operation used inside the API's multi-account transaction. */
  completeBoothTask(id: string) {
    return this.#change(() => {
      this.#active();
      if (!this.booths.some(b => b.id === id)) throw new GameArgumentError(new GameMessage('boothNotFound'));
      const repeated = this.#completeBoothProgress(this.#s, id);
      if (!repeated) this.#log('booth.complete', 'Recipient booth task completed', { args: { boothId: id } });
      return repeated;
    });
  }

  #findStation(id: string) {
    const station = this.stations.find(s => s.id === id);
    if (!station) throw new GameArgumentError(new GameMessage('stationNotFound'));
    return station;
  }

  #scanNew(uid: string, scanId: string) {
    if (uid === this.badgeUid || (uid === selfUid && this.badgeUid == null)) {
      this.#log('scan.self', `scanId=${scanId} UID=${uid}`);
      return new ScanResult('self', new GameMessage(this.checkedIn ? 'scan.self' : 'checkInRequired'), { uid, player: this.me });
    }
    const player = this.demoPlayers.find(p => p.id === uid);
    if (player != null) {
      this.#scannedPlayers.add(player.id);
      this.#log('scan.player', `scanId=${scanId} UID=${uid} ${player.name}`);
      return new ScanResult('player', new GameMessage('scan.player'), { uid, player });
    }
    const target = this.#boundTagTarget(uid);
    const number = checkpointByUid.get(uid) ?? checkpointNumberForTarget(target);
    if (number != null) {
      this.#active();
      if (Object.hasOwn(this.#s.checkpoints, number)) {
        this.#log('scan.checkpoint.repeat', `scanId=${scanId} UID=${uid} 打卡小石${number}再次掃描，無獎勵`);
        return new ScanResult('checkpoint', new GameMessage('checkpointRepeat', { number }), { uid });
      }
      this.#s.checkpoints[number] = stamp(this.now);
      const card = cardIndex(this.#draw());
      this.#s.hand[card]++;
      this.#log('scan.checkpoint', `scanId=${scanId} UID=${uid} 打卡小石${number}＋${cardNames[card]}1張`, { args: { number, card } });
      return new ScanResult('checkpoint', new GameMessage('checkpointFound', { number, card }), { uid });
    }
    const boothNumber = boothByUid.get(uid);
    if (boothNumber != null) {
      this.#active();
      const id = `booth-${boothNumber}`;
      if (!this.#s.boothVisited.includes(id)) this.#s.boothVisited.push(id);
      this.#log('scan.booth', `scanId=${scanId} UID=${uid} ${id}，只顯示介紹；任務由攤商回掃控制確認`);
      return new ScanResult('booth', new GameMessage('scan.booth'), { uid, booth: this.booths[boothNumber - 1] });
    }
    const stationId = stationByUid.get(uid) ?? target;
    if (stationId != null) {
      this.#active();
      const station = this.#findStation(stationId);
      const claimed = this.#s.stationClaims[stationId] ?? 0;
      let message: GameMessage;
      let awarded = false;
      if (!station.open) {
        message = new GameMessage('stationClosed');
      } else if (claimed >= station.limit) {
        message = new GameMessage('stationLimit');
      } else if (station.remaining < station.packs) {
        message = new GameMessage('stationEmpty');
      } else {
        this.#s.stationClaims[stationId] = claimed + 1;
        this.#s.stationStock[stationId] = station.remaining - station.packs;
        this.#s.packs += station.packs;
        awarded = true;
        message = new GameMessage('stationPacks', { count: station.packs });
      }
      this.#log('scan.station', `scanId=${scanId} UID=${uid} ${stationId}：${message.code}；未開卡包${this.packs}`,
        { args: { station: stationId, awarded, amount: awarded ? station.packs : 0 } });
      return new ScanResult('station', message, { uid, openPacks: awarded });
    }
    this.#log('scan.unknown', `scanId=${scanId} UID=${uid} 無法辨識`);
    return new ScanResult('unknown', new GameMessage('scan.unknown'), { uid });
  }

  get attendeeScans(): Readonly<Record<string, string>> {
    return Object.freeze({ ...this.#s.attendeeScans });
  }

  /** Server only: the worker has already checked both players' consent. */
  addAttendeeFriend(player: PlayerCard) {
    return this.#change(() => {
      this.#rememberAttendee(player);
      this.#addFriend(player.id, '互掃名牌');
    });
  }

  #rememberAttendee(player: PlayerCard) {
    const cards = this.#s.attendeeFriends ??= Object.create(null);
    cards[player.id] = playerJson(player);
  }

  /** Server only: both seats resolve inside the same persistence transaction. */
  applyAttendeeRound(resolved: Battle, consumed: HandCard, at: Date) {
    return this.#change(() => {
      const index = cardIndex(consumed);
      if (this.#s.hand[index] < 1) throw new GameStateError(new GameMessage('cardUnavailable'));
      this.#s.hand[index]--;
      this.#log('battle.round', `${resolved.id} 回合${resolved.rounds.length}：${cardNames[index]}；結果${resolved.rounds.at(-1)!.outcome}`, { at });
      if (resolved.finished) {
        this.#s.battle = battleJson(resolved);
        this.#rememberAttendee(resolved.opponent);
        this.#settle(resolved, at);
      }
    });
  }

  consumeAttendeePeek(battleId: string) {
    return this.#change(() => {
      if (this.peekCards < 1) throw new GameStateError(new GameMessage('peekEmpty'));
      this.#s.peek--;
      this.#log('battle.peek', `${battleId} 消耗透視卡1張`);
    });
  }

  requestFriend(playerId: string) {
    return this.#change(() => {
      this.#active();
      this.#findPlayer(playerId);
      if (!this.#scannedPlayers.has(playerId)) throw new GameStateError(new GameMessage('scanFirst'));
      if (Object.hasOwn(this.#s.friends, playerId)) return;
      this.#friendRequests.set(playerId, addSeconds(this.now, 30));
      this.#log('friend.request', `${playerId}：等待30秒內模擬對方回掃；不發獎勵`);
    });
  }

  simulateReciprocalScan(playerId: string) {
    return this.#change(() => {
      this.#active();
      this.#advanceExpired();
      const p = this.#findPlayer(playerId);
      const current = this.battle;
      if (current != null && !current.finished && !current.accepted && current.opponent.id === playerId) {
        const opponentHand = this.#s.opponentHands[playerId];
        if (totalCards(opponentHand) < 3) throw new GameStateError(new GameMessage('opponentCardsLow'));
        this.#s.battle = battleJson(new Battle({
          id: current.id, opponent: p, deadline: addSeconds(this.now, 10), accepted: true, opponentHand,
        }));
        this.#log('battle.accept', `${current.id} ${playerId} 模擬對手已回掃；第一回合10秒`);
        return;
      }
      const deadline = this.#friendRequests.get(playerId);
      if (deadline == null || !isBefore(this.now, deadline)) throw new GameStateError(new GameMessage('friendRequestExpired'));
      this.#friendRequests.delete(playerId);
      this.#addFriend(playerId, '互掃名牌');
    });
  }

  #addFriend(id: string, method: string, at?: Date) {
    if (Object.hasOwn(this.#s.friends, id)) return;
    this.#s.friends[id] = method;
    this.#log('friend.add', `${id} 好友成立，方式：${method}；好友本身不發金幣`, { at });
    this.#recomputeMissions(at);
  }

  #recomputeMissions(at?: Date) {
    const formal = this.friends;
    for (const mission of this.#s.missions) {
      if (mission.completedAt != null || formal.filter(p => p.tags.includes(mission.tag)).length < 3) continue;
      const coins = (this.#s.parameters ?? GameEngine.defaultParameters).missionCoins;
      mission.completedAt = stamp(at ?? this.now);
      this.#log('mission.complete', `Hashtag #${mission.tag} 3位正式好友；任務＋${coins}金幣`,
        { coins, at, args: { tag: mission.tag } });
    }
  }

  battleBlocked(opponent: PlayerCard) {
    if (this.phase !== EventPhase.active) return new GameMessage(this.phase === EventPhase.before ? 'eventBefore' : 'eventEnded');
    if (!this.checkedIn) return new GameMessage('checkInRequired');
    if (!this.#s.players.some(p => p.id === opponent.id) &&
        !(this.#s.players.length === 0 && this.role !== AccountRole.user && attendeeByUid.has(opponent.id))) {
      return new GameMessage('playerNotFound');
    }
    if (this.#s.battle?.finished === false) return new GameMessage('battleBusy');
    const cooldown = this.cooldownUntil;
    if (cooldown != null && isBefore(this.now, cooldown)) return new GameMessage('battleCooldown');
    if (totalCards(this.#s.hand) < 3) return new GameMessage('cardsLow');
    if (totalCards(this.#s.opponentHands[opponent.id]) < 3) return new GameMessage('opponentCardsLow');
    return null;
  }

  inviteBattle(playerId: string) {
    return this.#change(() => {
      this.#advanceExpired();
      const p = this.#findPlayer(playerId);
      const blocked = this.battleBlocked(p);
      if (blocked != null) throw new GameStateError(blocked);
      if (!this.#scannedPlayers.has(playerId)) throw new GameStateError(new GameMessage('scanFirst'));
      const id = `mock-battle-${++this.#s.sequence}`;
      this.#s.battle = battleJson(new Battle({
        id, opponent: p, deadline: addSeconds(this.now, 30), opponentHand: this.#s.opponentHands[p.id],
      }));
      this.#log('battle.invite', `${id} ${playerId}：等待30秒內模擬對方回掃`);
    });
  }

  cancelBattle() {
    return this.#change(() => {
      const b = this.#s.battle;
      if (b == null || b.finished) {
        this.#s.battle = null;
        return;
      }
      if (b.accepted) throw new GameStateError(new GameMessage('battleCannotCancel'));
      this.#s.battle = null;
      this.#log('battle.cancel', `${b.id} 取消邀請，未消耗卡牌`);
    });
  }

  playCard(card: HandCard, { asCard }: { asCard?: HandCard | null } = {}) {
    return this.#change(() => {
      this.#active();
      const before = this.battle;
      if (before == null || !before.accepted || before.finished) throw new GameStateError(new GameMessage('noBattle'));
      if (!isBefore(this.now, before.deadline)) {
        this.#advanceExpired();
        return; // A late tap cannot play into the following round.
      }
      if (this.#s.hand[cardIndex(card)] < 1) throw new GameStateError(new GameMessage('cardUnavailable'));
      if (card === HandCard.wild && (asCard == null || asCard === HandCard.wild)) {
        throw new GameArgumentError(new GameMessage('wildChoiceRequired'));
      }
      if (card !== HandCard.wild && asCard != null) throw new GameArgumentError(new GameMessage('normalCardFixed'));
      this.#resolveRound(before, card, card === HandCard.wild ? asCard! : card, false, this.now);
    });
  }

  #randomCard(cards: readonly number[]): HandCard {
    const normalCount = cards[0] + cards[1] + cards[2];
    if (normalCount === 0) {
      if (cards[3] === 0) throw new GameStateError(new GameMessage('battleCardsEmpty'));
      return HandCard.wild;
    }
    let choice = this.#random.nextInt(normalCount);
    for (let i = 0; i < 3; i++) {
      if (choice < cards[i]) return handCards[i];
      choice -= cards[i];
    }
    throw new GameStateError(new GameMessage('invalidCardCount'));
  }

  static roundOutcome(mine: HandCard, other: HandCard): number {
    if (mine === other) return 0;
    return (cardIndex(mine) - cardIndex(other) + 3) % 3 === 1 ? 1 : -1;
  }

  #resolveRound(b: Battle, consumed: HandCard, effective: HandCard, automatic: boolean, at: Date) {
    const mine = this.#s.hand;
    const mineIndex = cardIndex(consumed);
    mine[mineIndex]--;
    const other = [...b.opponentHand];
    const otherConsumed = this.#randomCard(other);
    const otherIndex = cardIndex(otherConsumed);
    other[otherIndex]--;
    const otherEffective = otherConsumed === HandCard.wild ? handCards[this.#random.nextInt(3)] : otherConsumed;
    const outcome = GameEngine.roundOutcome(effective, otherEffective);
    const rounds = [...b.rounds, new RoundResult(effective, otherEffective, outcome, { automatic, wild: consumed === HandCard.wild })];
    this.#s.opponentHands[b.opponent.id] = other;
    const finished = rounds.length >= 3 || b.wins + Number(outcome > 0) >= 2 || b.losses + Number(outcome < 0) >= 2;
    const next = new Battle({
      id: b.id, opponent: b.opponent, deadline: addSeconds(at, 10), accepted: true,
      rounds, finished, peekUsed: b.peekUsed, opponentHand: other,
    });
    this.#s.battle = battleJson(next);
    const choice = consumed === HandCard.wild ? `→${cardNames[cardIndex(effective)]}` : '';
    this.#log('battle.round',
      `${b.id} 回合${rounds.length}：${automatic ? '逾時代出' : '手動'} ${cardNames[mineIndex]}${choice}；` +
      `模擬對手${cardNames[otherIndex]}；結果${outcome}；雙方各消耗1張；剩餘手牌${displayHand(mine)}／${displayHand(other)}`, { at });
    if (finished) this.#settle(next, at);
  }

  #settle(b: Battle, at: Date) {
    const parameters = this.#s.parameters ?? GameEngine.defaultParameters;
    const result = b.result;
    const points = result > 0 ? 3 : result === 0 ? 1 : 0;
    const coins = result > 0 ? parameters.battleWinCoins : result === 0 ? parameters.battleDrawCoins : 0;
    const card = result >= 0 ? cardIndex(this.#draw()) : null;
    if (card != null) this.#s.hand[card]++;
    this.#s.points += points;
    this.#s.cooldown = stamp(addSeconds(at, parameters.battleCooldownSeconds));
    this.#s.history.push({ battle: battleJson(b), at: stamp(at), points, coins, reward: card });
    this.#log('battle.settle',
      `${b.id} 對手${b.opponent.id} 結果${result}；積分＋${points}；` +
      `${card == null ? '無抽牌' : `抽牌＋${cardNames[card]}1張`}；冷卻至${this.#s.cooldown}`,
      { coins, at, args: { points, result, card } });
    this.#addFriend(b.opponent.id, '對戰自動成為好友', at);
    this.#advanceHint(at);
  }

  usePeek() {
    return this.#change(() => {
      this.#active();
      const b = this.battle;
      if (b == null || b.finished || !b.accepted) throw new GameStateError(new GameMessage('peekTiming'));
      if (!isBefore(this.now, b.deadline)) {
        this.#advanceExpired();
        return;
      }
      if (b.peekUsed) throw new GameStateError(new GameMessage('peekUsed'));
      if (this.peekCards < 1) throw new GameStateError(new GameMessage('peekEmpty'));
      this.#s.peek--;
      this.#s.battle!.peekUsed = true;
      this.#log('battle.peek', `${b.id} 消耗透視卡1張；模擬對手收到使用通知；目前手牌${displayHand(b.opponentHand)}；倒數不暫停`);
    });
  }

  #advanceExpired() {
    for (const [id, deadline] of this.#friendRequests) {
      if (!isBefore(this.now, deadline)) this.#friendRequests.delete(id);
    }
    for (let b = this.battle; b != null && !b.finished && !isBefore(this.now, b.deadline); b = this.battle) {
      if (!b.accepted) {
        this.#s.battle = null;
        this.#log('battle.invite.expired', `${b.id} 30秒未回掃，取消且不消耗`, { at: b.deadline });
        return;
      }
      const selected = this.#randomCard(this.#s.hand);
      const effective = selected === HandCard.wild ? handCards[this.#random.nextInt(3)] : selected;
      this.#resolveRound(b, selected, effective, true, b.deadline);
    }
  }

  async tick() {
    await this.initialize();
    const current = this.battle;
    if (current != null && !current.finished && !isBefore(this.now, current.deadline)) {
      await this.#change(() => this.#advanceExpired());
    } else {
      for (const [id, deadline] of this.#friendRequests) {
        if (!isBefore(this.now, deadline)) this.#friendRequests.delete(id);
      }
    }
  }

  #draw(): HandCard {
    let bag = this.#s.bag;
    if (!bag.length) {
      bag = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
      for (let length = bag.length; length > 1; length--) {
        const picked = this.#random.nextInt(length);
        const last = length - 1;
        [bag[picked], bag[last]] = [bag[last], bag[picked]];
      }
      this.#s.bag = bag;
    }
    return handCards[bag.pop()!];
  }

  openPacks({ all = false } = {}) {
    return this.#change(() => {
      this.#active();
      if (this.packs < 1) throw new GameStateError(new GameMessage('packsEmpty'));
      const count = all ? this.packs : 1;
      const cards: HandCard[] = [];
      for (let i = 0; i < count * 3; i++) {
        const card = this.#draw();
        cards.push(card);
        this.#s.hand[cardIndex(card)]++;
      }
      this.#s.packs -= count;
      this.#log('pack.open',
        `開啟${count}包；抽出${cards.map(c => cardNames[cardIndex(c)]).join('、')}；剩餘卡包${this.packs}；手牌${displayHand(this.#s.hand)}`,
        { args: { count } });
      return Object.freeze(cards);
    });
  }

  buyEgg({ series }: { series?: number | null } = {}) {
    return this.#change(() => {
      this.#active();
      if (series != null && (!Number.isInteger(series) || series < 0 || series >= 6)) throw new GameArgumentError(new GameMessage('invalidSeries'));
      const price = series == null ? this.randomEggPrice : this.seriesEggPrice;
      if (this.coins < price) throw new GameStateError(new GameMessage('coinsShort', { amount: price - this.coins }));
      const hatch = this.#hatch(series ?? null);
      this.#log('egg.buy', `${series == null ? '隨機蛋' : `${seriesNames[series]}星球蛋`} 解鎖星球${hatch.planet}；花費${price}`,
        { coins: -price, args: { planet: hatch.planet } });
      return hatch;
    });
  }

  #hatch(series: number | null) {
    const owned = this.#s.planets;
    const first = series == null ? 0 : series * 7;
    const end = series == null ? 42 : first + 7;
    const available: number[] = [];
    for (let i = first; i < end; i++) {
      if (!Object.hasOwn(owned, i)) available.push(i);
    }
    if (!available.length) throw new GameStateError(new GameMessage(series == null ? 'allPlanetsOwned' : 'seriesOwned'));
    return this.#unlockPlanet(available[this.#random.nextInt(available.length)]);
  }

  #unlockPlanet(planet: number) {
    this.#s.planets[planet] = stamp(this.now);
    const group = Math.trunc(planet / 7);
    let completed = !this.#s.seriesRewards.includes(group);
    for (let i = group * 7; completed && i < (group + 1) * 7; i++) completed = Object.hasOwn(this.#s.planets, i);
    if (completed) {
      this.#s.seriesRewards.push(group);
      this.#s.hand[cardIndex(HandCard.wild)]++;
      this.#s.peek++;
      this.#s.packs++;
      this.#log('series.complete', `${seriesNames[group]}7色集滿；萬用卡＋1、透視卡＋1、卡包＋1、名片樣式${group}解鎖`,
        { args: { series: group } });
    }
    return new HatchResult(planet, completed);
  }

  selectAppearance(planet: number | null, style: number) {
    return this.#change(() => {
      if (planet != null && !Object.hasOwn(this.#s.planets, planet)) throw new GameStateError(new GameMessage('planetLocked'));
      if (!Number.isInteger(style) || style < -1 || style >= 6 || (style >= 0 && !this.#s.seriesRewards.includes(style))) {
        throw new GameStateError(new GameMessage('styleLocked'));
      }
      this.#s.planet = planet;
      this.#s.style = style;
      this.#log('appearance.edit', `代表星球${planet ?? '基本卡面'}；名片樣式${style}`);
    });
  }

  #advanceHint(at?: Date) {
    const total = this.hintRemainder + 1;
    const threshold = (this.#s.parameters ?? GameEngine.defaultParameters).hintThreshold;
    this.#s.hintCredits += Math.trunc(total / threshold);
    this.#s.hintRemainder = total % threshold;
    if (total >= threshold) this.#log('hint.earn', `累積${threshold}次對戰／攤位任務，提示＋1；剩餘${this.hintCredits}`, { at });
  }

  redeemHint() {
    return this.#change(() => {
      this.#active();
      if (this.hintCredits < 1) {
        throw new GameStateError(new GameMessage('hintsEmpty', { count: (this.#s.parameters ?? GameEngine.defaultParameters).hintThreshold }));
      }
      const available = this.checkpoints.filter(p => p.collectedAt == null && p.hint == null);
      if (!available.length) throw new GameStateError(new GameMessage('hintsExhausted'));
      const { number, area } = available[this.#random.nextInt(available.length)];
      const hint = new GameMessage('checkpointHint', { number, area });
      this.#s.hints[number] = hint.toJson();
      this.#s.hintCredits--;
      this.#log('hint.redeem', `${hint.code} {number: ${number}, area: ${area}}；提示－1`, { args: hint.args });
      return hint;
    });
  }

  ranking(metric: string) {
    let mine: number;
    let fixtureScore: (index: number) => number;
    switch (metric) {
      case 'points': mine = this.points; fixtureScore = i => (i * 7 + 3) % 46; break;
      case 'friends': mine = this.friends.length; fixtureScore = i => (i * 3) % 19; break;
      case 'planets': mine = Object.keys(this.#s.planets).length; fixtureScore = i => (i * 5) % 43; break;
      case 'checkpoints': mine = Object.keys(this.#s.checkpoints).length; fixtureScore = i => (i * 4) % 43; break;
      case 'missions': mine = this.#s.missions.filter(m => m.completedAt != null).length; fixtureScore = i => i % 7; break;
      default: throw new GameArgumentError(new GameMessage('unknownRanking', { metric }));
    }
    // Fixture standings are synthetic, never remote live data.
    const entries = this.demoPlayers.map((p, i) => new RankEntry(p, fixtureScore(i)));
    entries.push(new RankEntry(this.me, mine));
    entries.sort((a, b) => b.value - a.value || (a.player.id < b.player.id ? -1 : a.player.id > b.player.id ? 1 : 0));
    return Object.freeze(entries);
  }

  bindStation(uid: string, stationId: string) {
    return this.#change(() => {
      if (this.role !== AccountRole.staff) throw new GameStateError(new GameMessage('staffRequired'));
      const normalized = GameEngine.normalizeUid(uid);
      this.#findStation(stationId);
      if (normalized === selfUid || normalized === this.badgeUid || attendeeByUid.has(normalized) ||
          checkpointByUid.has(normalized) || boothByUid.has(normalized) || stationByUid.has(normalized) ||
          this.#bindingConflicts.has(normalized) || Object.hasOwn(this.#globalBindings ?? this.#s.bindings, normalized)) {
        throw new GameStateError(new GameMessage('uidReserved'));
      }
      this.#s.bindings[normalized] = stationId;
      this.#log('station.bind', `模擬工作人員把${normalized}綁定${stationId}`);
    });
  }

  /** Corrects one player's inventory without rewriting earned history. */
  adjustInventory({ resource, delta, expected, reason }: { resource: string; delta: number; expected: number; reason: string }) {
    return this.#change(() => {
      const field = resource === 'peekCards' ? 'peek' :
        resource === 'coins' || resource === 'points' || resource === 'packs' || resource === 'hintCredits' ? resource : null;
      const card = Object.hasOwn(HandCard, resource) ? cardIndex(resource as HandCard) : null;
      const planet = resource.startsWith('planet:') ? Number(resource.slice(7)) : NaN;
      const isPlanet = Number.isInteger(planet) && planet >= 0 && planet < 42 && resource === `planet:${planet}`;
      if ((field == null && card == null && !isPlanet) || !Number.isInteger(delta) || delta === 0 || (isPlanet && Math.abs(delta) !== 1)) {
        throw new GameArgumentError(new GameMessage('invalidInventoryAdjustment'));
      }
      const current = field != null ? this.#s[field] : card != null ? this.#s.hand[card] : Number(Object.hasOwn(this.#s.planets, planet));
      if (current !== expected) throw new GameStateError(new GameMessage('inventoryChanged'));
      if (delta < -current) throw new GameStateError(new GameMessage('inventoryInsufficient'));
      if (delta > (isPlanet ? 1 : Number.MAX_SAFE_INTEGER) - current) throw new GameStateError(new GameMessage('inventoryLimit'));
      if (card != null) {
        if (delta < 0 && this.#s.battle?.finished === false) throw new GameStateError(new GameMessage('inventoryBattleActive'));
        this.#s.hand[card] = current + delta;
      } else if (isPlanet) {
        if (delta > 0) {
          this.#unlockPlanet(planet);
        } else {
          delete this.#s.planets[planet];
          if (this.#s.planet === planet) this.#s.planet = null;
        }
      } else if (field != null && field !== 'coins') {
        this.#s[field] = current + delta;
      }
      this.#log('admin.inventory', `${resource}：${current} → ${current + delta}；${reason}`,
        { coins: resource === 'coins' ? delta : 0, args: { resource, delta, reason } });
    });
  }

  /** Local capability only, absent from the remote action allowlist. */
  grantLocalResources({ resource, amount }: { resource: string; amount: number }) {
    return this.#change(() => {
      if (!Number.isInteger(amount) || amount <= 0 || (resource !== 'coins' && resource !== 'packs')) {
        throw new GameArgumentError(new GameMessage('invalidGrant'));
      }
      const current = resource === 'coins' ? this.coins : this.packs;
      // The storage protocol uses JSON numbers, which must stay exactly representable in Node.
      if (amount > Number.MAX_SAFE_INTEGER - current) throw new GameArgumentError(new GameMessage('grantTooLarge'));
      if (resource === 'packs') this.#s.packs += amount;
      this.#log(`cheat.${resource}`, `Local grant: ${amount} ${resource}`, { coins: resource === 'coins' ? amount : 0, args: { amount } });
    });
  }

  setMockPhase(value: EventPhase) {
    return this.#change(() => {
      this.#advanceExpired();
      this.#s.phase = eventPhases.indexOf(value);
      this.#log('mock.phase', `本機模擬年會階段：${value}`);
    });
  }

  configureRole(role: AccountRole, { boothId }: { boothId?: string | null } = {}) {
    return this.#change(() => {
      if (role === AccountRole.booth && !this.booths.some(b => b.id === boothId)) {
        throw new GameArgumentError(new GameMessage('boothAssignmentRequired'));
      }
      this.#s.role = role;
      this.#s.boothId = role === AccountRole.booth ? boothId! : null;
      this.#log('admin.role', 'Account role assigned', { args: { role, boothId: this.#s.boothId } });
    });
  }

  simulateAgenda(slot: string) {
    return this.#change(() => {
      this.#active();
      if (!slot.trim()) throw new GameArgumentError(new GameMessage('agendaRequired'));
      if (this.#s.agenda.includes(slot)) return;
      this.#s.agenda.push(slot);
      const amount = (this.#s.parameters ?? GameEngine.defaultParameters).agendaPacks;
      this.#s.packs += amount;
      this.#log('mock.agenda', `模擬議程時段${slot}統一發包＋${amount}；未開卡包${this.packs}`, { args: { amount } });
    });
  }

  simulateBoothCompletion(id: string) {
    return this.#change(() => {
      this.#active();
      if (!this.booths.some(b => b.id === id)) throw new GameArgumentError(new GameMessage('boothNotFound'));
      if (this.#s.boothCompleted.includes(id)) return;
      this.#s.boothCompleted.push(id);
      if (!this.#s.boothVisited.includes(id)) this.#s.boothVisited.push(id);
      this.#log('mock.booth.complete', `${id} 模擬攤商回掃確認完成；不發金幣／卡包，計入提示`);
      this.#advanceHint();
    });
  }

  simulateRemotePacks(deliveryId: string, amount: number, reason: string) {
    return this.#change(() => {
      this.#active();
      if (!deliveryId.trim() || !reason.trim() || !Number.isInteger(amount) || amount < 1) {
        throw new GameArgumentError(new GameMessage('invalidDelivery'));
      }
      const existing = this.#s.deliveries[deliveryId];
      if (existing != null) {
        if (existing.amount !== amount || existing.reason !== reason) throw new GameStateError(new GameMessage('deliveryConflict'));
        return;
      }
      this.#s.deliveries[deliveryId] = { amount, reason };
      this.#s.packs += amount;
      this.#log('mock.remote', `deliveryId=${deliveryId}；模擬遠端發包＋${amount}；原因${reason}；未開卡包${this.packs}`, { args: { amount, reason } });
    });
  }

  simulatePhotoReward() {
    return this.#change(() => {
      this.#active();
      if (this.#s.photo) return;
      this.#s.photo = true;
      this.#s.packs++;
      this.#log('mock.photo', `模擬 Avatar chef 合照獎勵＋1包（每人一次）；未開卡包${this.packs}`);
    });
  }
}
