import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createGameWorker } from './worker.ts';

async function fixture(t, { remoteStationFixtures = false } = {}) {
  let document = JSON.stringify({ version: 1, players: {}, audit: [], phase: 'before', parameters: {}, stations: {} });
  let failWrite = false;
  let now = new Date('2026-11-22T09:00:00.000Z');
  const worker = createGameWorker({
    remoteStationFixtures,
    clock: () => now,
    persistence: {
      load: async () => document,
      save: async next => {
        if (failWrite) {
          failWrite = false;
          throw new Error('fixture write failed');
        }
        document = next;
      },
      ensureAvailable() {},
    },
  });
  const listening = once(worker, 'listening');
  worker.listen(0, '127.0.0.1');
  await listening;
  t.after(async () => {
    await new Promise(resolve => worker.close(resolve));
    await worker.drain();
  });
  const base = `http://127.0.0.1:${worker.address().port}`;
  async function request(path, { token, post } = {}) {
    const headers = {};
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (post !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, {
      method: post === undefined ? 'GET' : 'POST',
      headers,
      body: typeof post === 'string' ? post : JSON.stringify(post),
    });
    return { status: response.status, payload: await response.json() };
  }
  function success({ status, payload }) {
    assert.equal(status, 200, JSON.stringify(payload));
    return payload.data;
  }
  const admin = (action, args) => request('/api/admin/actions', { post: { action, args } });
  const action = (device, name, args) => request(`/api/players/${device.id}/actions`, {
    token: device.token, post: { action: name, args },
  });
  const state = async device => success(await request(`/api/players/${device.id}/state`, { token: device.token })).state;
  async function enroll() {
    const token = randomBytes(32).toString('base64url');
    const { playerId } = success(await request('/api/session/enroll', { token, post: {} }));
    return { id: playerId, token };
  }
  return {
    request, success, admin, action, state, enroll,
    nextWriteFails: () => { failWrite = true; },
    advance: ms => { now = new Date(now.getTime() + ms); },
    get document() { return document; },
  };
}

test('worker validates integer JSON tokens and treats record keys as own properties', async t => {
  const api = await fixture(t);
  for (const amount of ['2.0', '2e0']) {
    const reply = await api.request('/api/admin/actions', {
      post: `{"action":"parameters","args":{"agendaPacks":${amount}}}`,
    });
    assert.equal(reply.status, 422);
    assert.equal(reply.payload.error.code, 'invalid_argument');
    assert.deepEqual(reply.payload.error.message, { code: 'invalidInteger', args: { field: 'agendaPacks', min: 1, max: 3 } });
  }
  const valid = api.success(await api.admin('parameters', { agendaPacks: 2 }));
  assert.equal(valid.parameters.agendaPacks, 2);
  assert.equal(valid.audit.length, 1);
  for (const id of ['__proto__', 'constructor']) {
    const reply = await api.admin('photo', { playerId: id });
    assert.equal(reply.status, 404);
    assert.equal(reply.payload.error.code, 'player_not_found');
  }
  assert.deepEqual(Object.keys(JSON.parse(api.document).players), ['demo']);
});

test('device transfer is a single claim with a same-device receipt after expiry', async t => {
  const api = await fixture(t);
  const original = await api.enroll();
  const token = randomBytes(32).toString('base64url');
  const { code } = api.success(await api.request(`/api/players/${original.id}/transfer-code`, { token: original.token, post: {} }));
  const transfer = bearer => api.request('/api/session/transfer', { token: bearer, post: { code } });
  assert.deepEqual(api.success(await transfer(token)), { playerId: original.id });
  const stale = await api.request(`/api/players/${original.id}/state`, { token: original.token });
  assert.equal(stale.status, 401);
  api.advance(10 * 60 * 1000);
  assert.deepEqual(api.success(await transfer(token)), { playerId: original.id });
  const other = await transfer(randomBytes(32).toString('base64url'));
  assert.equal(other.status, 400);
  assert.equal(other.payload.error.code, 'device_transfer_invalid');
  for (const secret of [original.token, token, code.split('.')[1]]) assert.ok(!api.document.includes(secret));
});

test('an admin binding resolves a custom station immediately for an existing player', async t => {
  const api = await fixture(t, { remoteStationFixtures: true });
  api.success(await api.admin('phase', { phase: 'active' }));
  const player = await api.enroll();
  const badge = '04A70000000001';
  api.success(await api.action(player, 'bindBadge', { uid: badge }));
  api.success(await api.action(player, 'saveProfile', { tags: ['AI', 'Vim派', '夜貓族'], contact: '' }));
  const station = { stationId: 'station-custom', name: 'Custom', packs: 2, limit: 1, remaining: 10 };
  api.success(await api.admin('station', { ...station, open: false }));
  assert.equal(Object.hasOwn((await api.state(player)).stationFixtureUids, station.stationId), false);
  const bind = uid => api.admin('bindStationTag', { stationId: station.stationId, uid });
  for (const uid of [badge, '04E00000000001']) {
    assert.equal((await bind(uid)).payload.error.message.code, 'uidReserved');
  }
  const uid = '04A70000000002';
  const admin = api.success(await bind('04:a7:00:00:00:00:02'));
  assert.deepEqual(admin.stations.find(s => s.id === station.stationId).boundUids, [uid]);
  assert.equal((await api.state(player)).stationFixtureUids[station.stationId], uid);
  assert.equal((await bind(uid)).payload.error.message.code, 'uidReserved');
  const scan = async scanId => api.success(await api.action(player, 'scan', { uid, scanId }));
  assert.equal((await scan('closed')).result.message.code, 'stationClosed');
  api.success(await api.admin('station', { ...station, open: true }));
  const before = await api.state(player);
  const after = await scan('open');
  assert.equal(after.result.message.code, 'stationPacks');
  assert.equal(after.state.packs, before.packs + 2);
  assert.equal((await scan('again')).result.message.code, 'stationLimit');
  assert.equal((await api.admin('unbindTag', { uid, target: 'station-2' })).payload.error.message.code, 'tagBindingChanged');
  const removed = api.success(await api.admin('unbindTag', { uid, target: station.stationId }));
  assert.deepEqual(removed.stations.find(s => s.id === station.stationId).boundUids, []);
  assert.equal(Object.hasOwn((await api.state(player)).stationFixtureUids, station.stationId), false);
  assert.equal((await scan('removed')).result.kind, 'unknown');
  const unbadged = api.success(await api.admin('unbindBadge', { uid: badge, playerId: player.id }));
  assert.equal(unbadged.players.find(p => p.id === player.id).badgeUid, null);
  assert.equal((await api.state(player)).checkedIn, true);
  api.success(await bind(badge));
});

test('physical and fixture checkpoint tags share one reward and appear in admin statistics', async t => {
  const api = await fixture(t);
  api.success(await api.admin('phase', { phase: 'active' }));
  const player = await api.enroll();
  api.success(await api.action(player, 'bindBadge', { uid: '04A70000000001' }));
  api.success(await api.action(player, 'saveProfile', { tags: ['AI', 'Vim派', '夜貓族'], contact: '' }));
  const uid = '04A70000000003';
  const admin = api.success(await api.admin('bindCheckpointTag', { checkpointNumber: 1, uid }));
  assert.equal(Object.hasOwn(await api.state(player), 'stationFixtureUids'), false);
  assert.deepEqual(admin.checkpoints[0].boundUids, [uid]);
  const conflict = await api.admin('bindStationTag', { stationId: 'station-1', uid });
  assert.equal(conflict.payload.error.message.code, 'uidReserved');
  const scan = async (tag, scanId) => api.success(await api.action(player, 'scan', { uid: tag, scanId }));
  const first = await scan(uid, 'physical');
  assert.equal(first.result.kind, 'checkpoint');
  assert.equal(first.result.message.code, 'checkpointFound');
  assert.equal(first.result.message.args.number, 1);
  assert.equal((await scan('04C00000000001', 'fixture')).result.message.code, 'checkpointRepeat');
  const summary = api.success(await api.request('/api/admin/state')).checkpoints[0];
  assert.equal(summary.scans, 2);
  assert.equal(summary.collectedPlayers, 1);
  const removed = api.success(await api.admin('unbindTag', { uid, target: 'checkpoint-1' }));
  assert.deepEqual(removed.checkpoints[0].boundUids, []);
  assert.equal(removed.checkpoints[0].scans, 2);
  api.success(await api.admin('bindStationTag', { stationId: 'station-1', uid }));
});

test('a failed commit restores both players and the room before a locked round is retried', async t => {
  const api = await fixture(t);
  api.success(await api.admin('phase', { phase: 'active' }));
  const [a, b] = await Promise.all([api.enroll(), api.enroll()]);
  const [uidA, uidB] = ['04A70000000001', '04A70000000002'];
  for (const [device, uid] of [[a, uidA], [b, uidB]]) {
    api.success(await api.action(device, 'bindBadge', { uid }));
    api.success(await api.action(device, 'saveProfile', { tags: ['AI', 'Vim派', '夜貓族'], contact: '@private' }));
  }
  const scan = api.success(await api.action(a, 'scan', { uid: uidB, scanId: 'attendee-scan' }));
  assert.equal(scan.result.kind, 'attendee');
  assert.equal(scan.result.player.contact, '');
  const invite = api.success(await api.action(a, 'inviteBattle', { playerId: b.id }));
  const battleId = invite.state.multiplayer.battle.id;
  api.success(await api.action(b, 'respondBattle', { battleId, accept: true }));
  for (const player of [a, b]) api.success(await api.action(player, 'readyBattle', { battleId, round: 0 }));
  api.success(await api.action(a, 'playCard', { battleId, round: 0, card: 1 }));
  const before = api.document;
  const secondPick = () => api.action(b, 'playCard', { battleId, round: 0, card: 0 });
  api.nextWriteFails();
  const failure = await secondPick();
  assert.equal(failure.status, 503);
  assert.equal(failure.payload.error.code, 'storage_unavailable');
  assert.equal(api.document, before);
  const [locked, waiting] = await Promise.all([api.state(a), api.state(b)]);
  assert.equal(locked.multiplayer.battle.played, true);
  assert.equal(waiting.multiplayer.battle.played, false);
  assert.deepEqual(waiting.battle.rounds, []);
  for (const snap of [locked, waiting]) assert.deepEqual(snap.hand, [4, 4, 4, 0]);
  api.success(await secondPick());
  const [winner, loser] = await Promise.all([api.state(a), api.state(b)]);
  assert.equal(winner.battle.rounds[0].outcome, 1);
  assert.equal(loser.battle.rounds[0].outcome, -1);
  assert.deepEqual(winner.hand, [4, 3, 4, 0]);
  assert.deepEqual(loser.hand, [3, 4, 4, 0]);
});
