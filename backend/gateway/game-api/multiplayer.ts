import { randomBytes, randomInt } from 'node:crypto';
import {
  Battle, EventPhase, GameArgumentError, GameEngine, GameMessage, GameStateError, HandCard,
  PlayerCard, RoundResult, battleToWire, cardIndex, handCards, playerToWire,
} from '../game/engine.ts';
import type { BattleWire, PlayerWire } from '../game/engine.ts';
import type { BattlePick, BattleRoom, BattleRound, Store } from './store.ts';
import type { DeviceSessions } from './device-sessions.ts';

const inviteTime = 30_000;
const roundTime = 10_000;
const readyIdleTime = 120_000;
const incomingOffers = 'incomingFriendOffers';
const outgoingOffers = 'outgoingFriendOffers';
const seats = 'attendeeBattleSeats';
const rooms = 'attendeeBattles';
const noOffers: Readonly<Record<string, number>> = Object.freeze(Object.create(null));
const noRounds: readonly BattleRound[] = [];
type OfferIndex = typeof incomingOffers | typeof outgoingOffers;

export interface MultiplayerWire {
  incomingFriends: PlayerWire[];
  outgoingFriends: string[];
  scanned: string[];
  battle: { id: string; incoming: boolean; played: boolean; waitingReady: boolean; ready: boolean } | null;
}

function waitingForReady(at: Date): Partial<BattleRoom> {
  return {
    waitingReady: true,
    readyA: false,
    readyB: false,
    deadline: at.getTime() + readyIdleTime,
  };
}

function automaticPick(player: GameEngine): BattlePick {
  const cards = player.hand;
  const normal = cards[0] + cards[1] + cards[2];
  if (normal === 0) return [cardIndex(HandCard.wild), randomInt(3), true];
  let chosen = randomInt(normal);
  for (let i = 0; i < 3; i++) {
    if (chosen < cards[i]) return [i, i, true];
    chosen -= cards[i];
  }
  throw new Error('Invalid attendee hand');
}

// Called within the serialized store transaction. Replacing rather than
// mutating room/offer records lets both players roll back together.
export class Multiplayer {
  #store: Store;
  #clock: () => Date;
  #player: (id: string) => Promise<GameEngine>;
  #sessions: DeviceSessions;

  constructor(store: Store, clock: () => Date, player: (id: string) => Promise<GameEngine>, sessions: DeviceSessions) {
    this.#store = store;
    this.#clock = clock;
    this.#player = player;
    this.#sessions = sessions;
  }

  static publicCard(id: string, core: GameEngine): PlayerCard {
    const { name, tags, planet, style, roles } = core.me;
    return new PlayerCard({ id, name, tags, planet, style, roles });
  }

  #active(player: GameEngine): void {
    if (player.phase !== EventPhase.active) {
      throw new GameStateError(new GameMessage(player.phase === EventPhase.before ? 'eventBefore' : 'eventEnded'));
    }
    if (!player.checkedIn) throw new GameStateError(new GameMessage('checkInRequired'));
  }

  async #target(actor: string, core: GameEngine, peer: string): Promise<GameEngine> {
    this.#active(core);
    if (peer === actor || !this.#sessions.isEnrolled(peer)) {
      throw new GameArgumentError(new GameMessage('playerNotFound'));
    }
    const target = await this.#player(peer);
    this.#active(target);
    if (target.badgeUid == null || core.attendeeScans[peer] !== target.badgeUid) {
      throw new GameStateError(new GameMessage('scanFirst'));
    }
    return target;
  }

  #offers(key: OfferIndex, id: string): Readonly<Record<string, number>> {
    return this.#store.sessionMap(key)[id] ?? noOffers;
  }

  #editOffer(key: OfferIndex, id: string, peer: string, deadline?: number): void {
    const now = this.#clock().getTime();
    const next: Record<string, number> = Object.create(null);
    for (const [player, expiresAt] of Object.entries(this.#offers(key, id))) {
      if (player !== peer && expiresAt > now) next[player] = expiresAt;
    }
    if (deadline !== undefined) next[peer] = deadline;
    const index = this.#store.editSessionMap(key);
    if (Object.keys(next).length === 0) delete index[id];
    else index[id] = next;
  }

  #clearOffer(sender: string, recipient: string): void {
    if (!Object.hasOwn(this.#offers(outgoingOffers, sender), recipient)) return;
    this.#editOffer(outgoingOffers, sender, recipient);
    this.#editOffer(incomingOffers, recipient, sender);
  }

  async requestFriend(actor: string, core: GameEngine, peer: string): Promise<void> {
    await this.#target(actor, core, peer);
    if (Object.hasOwn(core.friendMethods, peer)) return;
    const now = this.#clock().getTime();
    if ((this.#offers(outgoingOffers, actor)[peer] ?? 0) > now) return;
    const deadline = now + inviteTime;
    this.#editOffer(outgoingOffers, actor, peer, deadline);
    this.#editOffer(incomingOffers, peer, actor, deadline);
  }

  async respondFriend(actor: string, core: GameEngine, sender: string, accept: boolean): Promise<void> {
    this.#active(core);
    const offers = this.#offers(incomingOffers, actor);
    if (!Object.hasOwn(offers, sender) || offers[sender] <= this.#clock().getTime()) {
      if (accept && Object.hasOwn(core.friendMethods, sender)) return;
      throw new GameStateError(new GameMessage('friendRequestExpired'));
    }
    if (accept) {
      const peer = await this.#player(sender);
      this.#active(peer);
      await core.addAttendeeFriend(Multiplayer.publicCard(sender, peer));
      await peer.addAttendeeFriend(Multiplayer.publicCard(actor, core));
      this.#clearOffer(actor, sender);
    }
    this.#clearOffer(sender, actor);
  }

  roomFor(player: string): Room | null {
    const index = this.#store.sessionMap(seats);
    return Object.hasOwn(index, player) ? new Room(this.#store.sessionMap(rooms)[index[player]]) : null;
  }

  #update(room: Room): void {
    this.#store.editSessionMap(rooms)[room.id] = room.data;
  }

  #close(room: Room): void {
    delete this.#store.editSessionMap(rooms)[room.id];
    const index = this.#store.editSessionMap(seats);
    delete index[room.a];
    delete index[room.b];
  }

  #eligible(player: GameEngine, now: Date, other = false): void {
    if (player.battle?.finished === false) throw new GameStateError(new GameMessage('battleBusy'));
    const cooldown = player.cooldownUntil;
    if (cooldown != null && cooldown > now) throw new GameStateError(new GameMessage('battleCooldown'));
    if (player.hand.reduce((sum, n) => sum + n, 0) < 3) {
      throw new GameStateError(new GameMessage(other ? 'opponentCardsLow' : 'cardsLow'));
    }
  }

  async invite(actor: string, core: GameEngine, peer: string): Promise<void> {
    const target = await this.#target(actor, core, peer);
    await this.advance(peer);
    await target.tick();
    const existing = this.roomFor(actor);
    if (existing && !existing.accepted && existing.a === actor && existing.b === peer) return;
    if (existing || this.roomFor(peer)) throw new GameStateError(new GameMessage('battleBusy'));
    const now = this.#clock();
    this.#eligible(core, now);
    this.#eligible(target, now, true);
    const id = `live-${randomBytes(18).toString('base64url')}`;
    this.#update(new Room({ id, a: actor, b: peer, deadline: now.getTime() + inviteTime }));
    const index = this.#store.editSessionMap(seats);
    index[actor] = id;
    index[peer] = id;
  }

  #requireRoom(actor: string, id: string): Room {
    const room = this.roomFor(actor);
    if (room?.id !== id) throw new GameStateError(new GameMessage('noBattle'));
    return room;
  }

  async respond(actor: string, core: GameEngine, id: string, accept: boolean): Promise<void> {
    const room = this.#requireRoom(actor, id);
    if (room.a === actor || room.accepted || room.deadline <= this.#clock().getTime()) {
      throw new GameStateError(new GameMessage('noBattle'));
    }
    if (!accept) {
      this.#close(room);
      return;
    }
    const inviter = await this.#player(room.a);
    this.#active(core);
    this.#active(inviter);
    const now = this.#clock();
    this.#eligible(core, now);
    this.#eligible(inviter, now, true);
    this.#update(room.change({ accepted: true, ...waitingForReady(now) }));
  }

  ready(actor: string, id: string, round: number): void {
    const room = this.#requireRoom(actor, id);
    if (!room.accepted || room.rounds.length !== round || room.deadline <= this.#clock().getTime()) {
      throw new GameStateError(new GameMessage('noBattle'));
    }
    if (!room.waitingReady || room.isReady(actor)) return;
    const change: Partial<BattleRoom> = { [room.readyKey(actor)]: true };
    if (room.isReady(room.peer(actor))) {
      change.waitingReady = false;
      change.deadline = this.#clock().getTime() + roundTime;
    }
    this.#update(room.change(change));
  }

  cancel(actor: string, id: string): void {
    const room = this.#requireRoom(actor, id);
    const canCancel = room.accepted ? room.waitingReady && room.rounds.length === 0 : room.a === actor;
    if (!canCancel) throw new GameStateError(new GameMessage('battleCannotCancel'));
    this.#close(room);
  }

  #round(actor: string, id: string, round: number): Room {
    const room = this.#requireRoom(actor, id);
    if (!room.accepted || room.waitingReady || room.rounds.length !== round || room.deadline <= this.#clock().getTime()) {
      throw new GameStateError(new GameMessage('noBattle'));
    }
    return room;
  }

  async play(actor: string, core: GameEngine, id: string, round: number, card: HandCard, asCard: HandCard | null): Promise<void> {
    const room = this.#round(actor, id, round);
    if (room.pick(actor) != null) return; // A locked card cannot be changed.
    if (card === HandCard.wild && (asCard == null || asCard === HandCard.wild)) {
      throw new GameArgumentError(new GameMessage('wildChoiceRequired'));
    }
    if (card !== HandCard.wild && asCard != null) {
      throw new GameArgumentError(new GameMessage('normalCardFixed'));
    }
    const index = cardIndex(card);
    if (core.hand[index] < 1) throw new GameStateError(new GameMessage('cardUnavailable'));
    const next = room.change({ [room.pickKey(actor)]: [index, cardIndex(asCard ?? card), false] });
    if (next.pick(next.peer(actor)) == null) this.#update(next);
    else await this.#resolve(next, this.#clock());
  }

  async peek(actor: string, core: GameEngine, id: string, round: number): Promise<void> {
    const room = this.#round(actor, id, round);
    const key = room.peekKey(actor);
    if (room.data[key] != null) throw new GameStateError(new GameMessage('peekUsed'));
    if (room.pick(actor) != null) throw new GameStateError(new GameMessage('peekTiming'));
    await core.consumeAttendeePeek(id);
    // The snapshot stays fixed after reveal and never includes locked choices.
    this.#update(room.change({ [key]: (await this.#player(room.peer(actor))).hand }));
  }

  async #resolve(room: Room, at: Date): Promise<void> {
    const a = await this.#player(room.a);
    const b = await this.#player(room.b);
    const pickA = room.pick(room.a) ?? automaticPick(a);
    const pickB = room.pick(room.b) ?? automaticPick(b);
    const outcome = GameEngine.roundOutcome(handCards[pickA[1]], handCards[pickB[1]]);
    const rounds: BattleRound[] = [...room.rounds, [pickA, pickB, outcome]];
    const wins = rounds.filter(r => r[2] === 1).length;
    const losses = rounds.filter(r => r[2] === -1).length;
    const finished = rounds.length === 3 || wins === 2 || losses === 2;
    const next = room.change({ rounds, ...waitingForReady(at), pickA: null, pickB: null });
    await a.applyAttendeeRound(next.view(room.a, Multiplayer.publicCard(room.b, b), finished), handCards[pickA[0]], at);
    await b.applyAttendeeRound(next.view(room.b, Multiplayer.publicCard(room.a, a), finished), handCards[pickB[0]], at);
    if (finished) {
      this.#clearOffer(room.a, room.b);
      this.#clearOffer(room.b, room.a);
      this.#close(room);
    } else {
      this.#update(next);
    }
  }

  async advance(actor: string): Promise<void> {
    const now = this.#clock().getTime();
    while (true) {
      const room = this.roomFor(actor);
      if (!room || room.deadline > now) return;
      if (!room.accepted || room.waitingReady) {
        this.#close(room);
        return;
      }
      await this.#resolve(room, new Date(room.deadline));
    }
  }

  async snapshot(actor: string, core: GameEngine): Promise<{ liveBattle: BattleWire | null; multiplayer: MultiplayerWire }> {
    const now = this.#clock().getTime();
    const room = this.roomFor(actor);
    let liveBattle: BattleWire | null = null;
    if (room) {
      const peer = room.peer(actor);
      liveBattle = battleToWire(room.view(actor, Multiplayer.publicCard(peer, await this.#player(peer))));
    }
    const incomingFriends: PlayerWire[] = [];
    for (const [peer, expiresAt] of Object.entries(this.#offers(incomingOffers, actor))) {
      if (expiresAt > now) incomingFriends.push(playerToWire(Multiplayer.publicCard(peer, await this.#player(peer))));
    }
    return {
      liveBattle,
      multiplayer: {
        incomingFriends,
        outgoingFriends: Object.entries(this.#offers(outgoingOffers, actor))
          .filter(([, expiresAt]) => expiresAt > now).map(([peer]) => peer),
        scanned: Object.entries(core.attendeeScans)
          .filter(([peer, badge]) => this.#store.data.players[peer]?.badge === badge).map(([peer]) => peer),
        battle: room && {
          id: room.id,
          incoming: room.b === actor,
          played: room.pick(actor) != null,
          waitingReady: room.waitingReady,
          ready: room.isReady(actor),
        },
      },
    };
  }
}

class Room {
  readonly data: BattleRoom;

  constructor(data: BattleRoom) {
    this.data = data;
  }

  get id(): string { return this.data.id; }
  get a(): string { return this.data.a; }
  get b(): string { return this.data.b; }
  get accepted(): boolean { return this.data.accepted === true; }
  get waitingReady(): boolean { return this.data.waitingReady === true; }
  get deadline(): number { return this.data.deadline; }
  get rounds(): readonly BattleRound[] { return this.data.rounds ?? noRounds; }
  readyKey(player: string): 'readyA' | 'readyB' { return player === this.a ? 'readyA' : 'readyB'; }
  isReady(player: string): boolean { return this.data[this.readyKey(player)] === true; }
  peer(player: string): string { return player === this.a ? this.b : this.a; }
  pickKey(player: string): 'pickA' | 'pickB' { return player === this.a ? 'pickA' : 'pickB'; }
  peekKey(player: string): 'peekA' | 'peekB' { return player === this.a ? 'peekA' : 'peekB'; }
  pick(player: string): BattlePick | null | undefined { return this.data[this.pickKey(player)]; }
  change(fields: Partial<BattleRoom>): Room { return new Room({ ...this.data, ...fields }); }

  view(actor: string, opponent: PlayerCard, finished = false): Battle {
    const first = actor === this.a;
    const shownHand = this.data[this.peekKey(actor)];
    return new Battle({
      id: this.id,
      opponent,
      deadline: new Date(this.deadline),
      accepted: this.accepted,
      finished,
      peekUsed: shownHand != null,
      opponentHand: shownHand ?? [0, 0, 0, 0],
      rounds: this.rounds.map(([a, b, outcome]) => {
        const mine = first ? a : b;
        const peer = first ? b : a;
        return new RoundResult(handCards[mine[1]], handCards[peer[1]], first ? outcome : -outcome, {
          automatic: mine[2], wild: mine[0] === cardIndex(HandCard.wild),
        });
      }),
    });
  }
}
