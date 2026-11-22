import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRole, EventPhase, GameEngine, GameSnapshot, HandCard, ScannerMode, gameToWire } from './engine.ts';

class MemoryStorage {
  value = null;
  failWrite = false;
  async read() { return this.value; }
  async write(value) {
    if (this.failWrite) throw new Error('disk unavailable');
    this.value = value;
  }
}

const start = '2026-03-28T09:00:00.000Z';
const tags = ['AI', 'Vim派', '夜貓族'];
const random = { nextInt: () => 0 };
const code = expected => error => error.localizedMessage?.code === expected;

async function checkedIn(options = {}) {
  const game = new GameEngine({ storage: new MemoryStorage(), random, clock: () => new Date(start), initialPhase: EventPhase.active, ...options });
  await game.bindBadge(GameEngine.selfUid);
  await game.saveProfile(tags, '');
  return game;
}

test('Dart v1 receipts migrate without awarding twice or leaking core storage', async () => {
  const game = await checkedIn();
  const checkpoint = GameEngine.checkpointUid(1);
  await game.scan(checkpoint, 'legacy-scan');
  const before = game.hand;
  const save = JSON.parse(game.exportState());
  delete save.role;
  delete save.boothId;
  delete save.recipients;
  delete save.stationConfigs;
  save.staff = true;
  save.checkpoints[1] = '2026-03-28T09:00:00.000456Z';
  const receipt = save.scans['legacy-scan'];
  delete receipt.mode;
  delete receipt.assignedBooth;
  delete receipt.repeated;
  delete receipt.message;
  const storage = new MemoryStorage();
  storage.value = JSON.stringify(save);
  const restored = new GameEngine({ storage, random });
  await restored.initialize();
  assert.equal(restored.role, AccountRole.staff);
  assert.deepEqual(restored.hand, before);
  assert.equal(JSON.parse(storage.value).staff, undefined);
  assert.equal((await restored.scan(checkpoint, 'legacy-scan')).message.code, 'scan.checkpoint');
  assert.deepEqual(restored.hand, before);
  await assert.rejects(restored.scan(checkpoint, 'legacy-scan', { mode: ScannerMode.staff }), code('scanIdConflict'));
  const wire = gameToWire(restored);
  assert.equal(wire.checkpoints[0].collectedAt, save.checkpoints[1]);
  for (const field of ['staff', 'scans', 'bag', 'bindings', 'recipients']) assert.ok(!Object.hasOwn(wire, field));
  assert.deepEqual(gameToWire(GameSnapshot.fromJson(JSON.parse(JSON.stringify(wire)))), wire);
});

test('a failed commit rolls back scan intent, receipt, and checkpoint reward without poisoning the mutation queue', async () => {
  const storage = new MemoryStorage();
  const game = await checkedIn({ storage });
  const fixture = GameEngine.playerUid(1);
  const checkpoint = GameEngine.checkpointUid(1);
  const before = storage.value;
  storage.failWrite = true;
  await assert.rejects(game.scan(fixture, '__proto__'), code('storageFailure'));
  await assert.rejects(game.scan(checkpoint, 'checkpoint'), code('storageFailure'));
  assert.equal(game.exportState(), before);
  storage.failWrite = false;
  await assert.rejects(game.requestFriend(fixture), code('scanFirst'));
  await game.scan(fixture, '__proto__');
  await game.requestFriend(fixture);
  await game.simulateReciprocalScan(fixture);
  assert.equal(game.friends[0].id, fixture);
  await game.scan(checkpoint, 'checkpoint');
  const after = game.hand;
  await game.scan(checkpoint, 'checkpoint');
  assert.deepEqual(game.hand, after);
  assert.equal(game.checkpoints[0].collectedAt.toISOString(), start);
});

test('late battle taps catch up from prior deadlines and retain numeric v1/v3 card fields', async () => {
  let time = Date.parse(start);
  const game = await checkedIn({ clock: () => new Date(time) });
  const player = GameEngine.playerUid(1);
  await game.scan(player, 'player');
  await game.inviteBattle(player);
  await game.simulateReciprocalScan(player);
  time += 10_000;
  await game.playCard(HandCard.rock);
  assert.equal(game.battle.rounds.length, 1);
  assert.equal(game.battle.rounds[0].mine, HandCard.scissors);
  assert.equal(game.battle.rounds[0].automatic, true);
  assert.equal(game.hand[1], 4);
  time += 30_000;
  await game.tick();
  assert.equal(game.battle.finished, true);
  assert.equal(game.history[0].at.getTime(), Date.parse(start) + 30_000);
  assert.equal(game.cooldownUntil.getTime(), Date.parse(start) + 90_000);
  assert.equal(game.points, 1);
  assert.equal(game.coins, 10);
  const persisted = JSON.parse(game.exportState());
  const wire = gameToWire(game);
  assert.deepEqual(wire.battle.rounds, persisted.battle.rounds);
  assert.deepEqual(wire.battle.rounds.map(r => r.mine), [0, 0, 0]);
  assert.equal(typeof wire.history[0].reward, 'number');
  assert.ok(!Object.hasOwn(persisted.battle.opponent, 'roles'));
  assert.deepEqual(wire.battle.opponent.roles, ['會眾']);
});
