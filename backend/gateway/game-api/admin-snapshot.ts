import { GameEngine, boothToWire, stationToWire } from '../game/engine.ts';
import { checkpointNumberForTarget } from '../game/fixtures.ts';
import { isBefore, parseDate, stamp } from '../game/time.ts';
import type { Store } from './store.ts';

const uidPattern = /UID=([0-9A-F]{14})/;
const checkpointNumbers = new Map(Array.from({ length: 42 }, (_, i) => [GameEngine.checkpointUid(i + 1), i + 1]));

export function adminSnapshot(store: Store, players: [string, GameEngine][], demo: GameEngine, clock: () => Date) {
  const checkpoints = demo.checkpoints.map(({ number, area }) =>
    ({ number, area, scans: 0, collectedPlayers: 0, last: null as Date | null }));
  const checkpointByTag = new Map(checkpointNumbers);
  const uidsByTarget = new Map<string, string[]>();
  const conflicts = new Set(store.data.bindingConflicts);
  for (const [uid, target] of Object.entries(store.data.bindings)) {
    if (conflicts.has(uid)) continue;
    const number = checkpointNumberForTarget(target);
    if (number !== undefined && !checkpointByTag.has(uid)) checkpointByTag.set(uid, number);
    const uids = uidsByTarget.get(target);
    if (uids) uids.push(uid);
    else uidsByTarget.set(target, [uid]);
  }
  const recentLedger: { playerId: string; at: string; reason: string; detail: string; coins: number }[] = [];
  const metrics = {
    players: players.length, checkedIn: 0, coins: 0, points: 0, packs: 0, handTotal: 0, planets: 0,
    friends: 0, checkpoints: 0, missions: 0, battles: 0, scans: 0, auditActions: store.data.audit.length,
  };
  const summaries = players.map(([id, core]) => {
    const state = store.data.players[id];
    for (const entry of state.ledger) {
      if (entry.reason !== 'scan.checkpoint' && entry.reason !== 'scan.checkpoint.repeat') continue;
      const uid = uidPattern.exec(entry.detail)?.[1];
      const number = uid === undefined ? undefined : checkpointByTag.get(uid);
      if (number !== undefined) {
        const checkpoint = checkpoints[number - 1];
        const at = parseDate(entry.at);
        if (checkpoint.last == null || isBefore(checkpoint.last, at)) checkpoint.last = at;
      }
    }
    for (const checkpoint of checkpoints) {
      const recordedAt = state.checkpoints[checkpoint.number];
      if (recordedAt != null) {
        checkpoint.collectedPlayers++;
        const at = parseDate(recordedAt);
        if (checkpoint.last == null || isBefore(checkpoint.last, at)) checkpoint.last = at;
      }
    }
    for (const scan of Object.values(state.scans)) {
      const number = checkpointByTag.get(scan.source);
      if (number !== undefined) checkpoints[number - 1].scans++;
      metrics.scans++;
    }
    for (const log of core.ledger) {
      recentLedger.push({ playerId: id, at: stamp(log.at), reason: log.reason, detail: log.detail, coins: log.coins });
    }
    const hand = core.hand;
    const ownedPlanets = [...core.planets];
    const summary = {
      id,
      name: core.me.name,
      checkedIn: core.checkedIn,
      badgeUid: core.badgeUid,
      coins: core.coins,
      points: core.points,
      packs: core.packs,
      peekCards: core.peekCards,
      hintCredits: core.hintCredits,
      hand,
      ownedPlanets,
      handTotal: hand.reduce((sum, n) => sum + n, 0),
      planets: ownedPlanets.length,
      friends: core.friends.length,
      checkpoints: core.checkpoints.filter(c => c.collectedAt != null).length,
      missions: core.missions.filter(m => m.completedAt != null).length,
      role: core.role,
      boothId: core.boothId,
    };
    if (summary.checkedIn) metrics.checkedIn++;
    metrics.coins += summary.coins;
    metrics.points += summary.points;
    metrics.packs += summary.packs;
    metrics.handTotal += summary.handTotal;
    metrics.planets += summary.planets;
    metrics.friends += summary.friends;
    metrics.checkpoints += summary.checkpoints;
    metrics.missions += summary.missions;
    metrics.battles += core.history.length;
    return summary;
  });
  recentLedger.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  const stationsByPlayer = players.map(([id, core]) => [id, core.stations] as const);
  return {
    mode: 'test',
    phase: store.data.phase,
    serverTime: stamp(clock()),
    accountMode: 'independent-test-fixtures',
    players: summaries,
    // Stock is independent per test account, not shared event inventory.
    stations: demo.stations.map(station => ({
      ...stationToWire(station),
      boundUids: uidsByTarget.get(station.id) ?? [],
      remainingByPlayer: Object.fromEntries(stationsByPlayer.map(([id, stations]) =>
        [id, stations.find(candidate => candidate.id === station.id)!.remaining])),
    })),
    booths: demo.booths.map(boothToWire),
    checkpoints: checkpoints.map(({ number, area, scans, collectedPlayers, last }) => ({
      number, area, scans, collected: collectedPlayers > 0, collectedPlayers,
      boundUids: uidsByTarget.get(`checkpoint-${number}`) ?? [],
      lastScan: last == null ? null : stamp(last),
    })),
    audit: store.data.audit.slice(-200).reverse(),
    recentLedger: recentLedger.slice(0, 100),
    metrics,
    parameters: demo.parameters,
  };
}
