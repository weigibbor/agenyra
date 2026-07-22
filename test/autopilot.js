'use strict';
// Headless tests for the Phase 4B Autopilot engine: mission store CRUD,
// engine transitions (queue → running → done/blocked/review), topology
// validation, completion contract, and restart interruption.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionStore } = require('../main/missions');
const { RunLog } = require('../main/runlog');
const { AutopilotEngine } = require('../main/autopilot-engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-autopilot-'));

// ---- mocks -----------------------------------------------------------------
function makeMocks() {
  const routed = [];
  const panes = new Map();
  const pty = {
    handlers: {},
    on(ev, cb) { this.handlers[ev] = cb; },
    get(id) { return panes.get(id); },
    list() { return [...panes.values()]; },
    _add(p) { panes.set(p.id, p); },
    _exit(id, code) { panes.delete(id); if (this.handlers.exit) this.handlers.exit({ id, exitCode: code }); },
  };
  const wires = [];
  const router = {
    openMesh: false,
    listWires() { return wires.slice(); },
    _wire(from, to) { wires.push({ from, to }); },
    route(from, to, message) { routed.push({ from, to, message }); return { ok: true }; },
  };
  const guard = {
    paused: false,
    handlers: {},
    on(ev, cb) { this.handlers[ev] = cb; },
    stats() { return { paused: this.paused }; },
    resume() { this.paused = false; },
  };
  const folders = new Map([['f1', { id: 'f1', name: 'demo', repo: tmp, isGit: false, wtm: { list: () => [], diff: async () => ({ patch: '' }) } }]]);
  return { pty, router, guard, folders, routed };
}

async function main() {
  // ---- store CRUD + persistence ---------------------------------------------
  const store = new MissionStore(tmp);
  const a = store.add('f1', 'build the login page');
  assert.equal(a.ok, true);
  assert.equal(a.mission.status, 'queued');
  assert.equal(store.add('f1', '').ok, false, 'empty goal rejected');
  const b = store.add('f1', 'write the tests');
  assert.equal(store.list('f1').length, 2);
  assert.equal(store.nextFor('f1').id, a.mission.id, 'FIFO dequeue');
  store.setStatus(a.mission.id, 'running');
  assert.equal(store.nextFor('f1'), null, 'per-folder serialization while active');
  store.setStatus(a.mission.id, 'done');
  assert.equal(store.nextFor('f1').id, b.mission.id, 'advances after done');
  const store2 = new MissionStore(tmp);
  assert.equal(store2.list().length, 2, 'missions persist to disk');
  store2.setStatus(b.mission.id, 'running');
  const interrupted = new MissionStore(tmp).markInterrupted();
  assert.equal(interrupted, 1, 'running mission marked interrupted on boot');
  console.log('✓ mission store CRUD + persistence + interruption OK');

  // ---- engine: topology validation + start + completion ---------------------
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'am-autopilot2-'));
  const m = makeMocks();
  const missions = new MissionStore(tmp2);
  const runlog = new RunLog(tmp2);
  const engine = new AutopilotEngine({ stateDir: tmp2, missions, runlog, pty: m.pty, router: m.router, guard: m.guard, folders: m.folders });
  engine.setState({ autopilotOn: true, mode: 'supervised' });

  // no agents at all → blocked (no HEAD)
  engine.addMission('f1', 'first goal');
  assert.equal(missions.list('f1')[0].status, 'blocked', 'no-HEAD folder blocks the mission');
  assert.ok(/no HEAD/.test(missions.list('f1')[0].blockReason));

  // HEAD + worker but one-directional wiring → blocked with wiring hint
  m.pty._add({ id: 'h1', role: 'head', folderId: 'f1' });
  m.pty._add({ id: 'w1', role: 'worker', folderId: 'f1' });
  m.router._wire('h1', 'w1'); // send only, no way back
  engine.addMission('f1', 'second goal');
  const second = missions.list('f1')[1];
  assert.equal(second.status, 'blocked');
  assert.ok(/both directions/.test(second.blockReason), 'wiring hint surfaced');

  // full two-way wiring → mission starts and the goal reaches the HEAD
  m.router._wire('w1', 'h1');
  engine.addMission('f1', 'third goal');
  const third = missions.list('f1')[2];
  assert.equal(third.status, 'running', 'mission started');
  assert.equal(third.assigneeHead, 'h1');
  const goalMsg = m.routed.find((r) => r.to === 'h1' && /third goal/.test(r.message));
  assert.ok(goalMsg, 'goal routed to HEAD');
  assert.ok(/mesh mission done/.test(goalMsg.message), 'protocol addendum included');

  // completion contract: wrong sender rejected; assigned HEAD accepted
  const wrong = await engine.missionDone('w1', 'done!');
  assert.equal(wrong.ok, false, 'non-assigned sender rejected');
  const right = await engine.missionDone('h1', 'all finished');
  assert.equal(right.ok, true);
  assert.equal(right.status, 'done', 'no branches → done directly');
  assert.equal(missions.get(third.id).status, 'done');
  const dup = await engine.missionDone('h1', 'again');
  assert.equal(dup.ok, false, 'double done rejected (no running mission)');

  // blocked contract
  engine.addMission('f1', 'fourth goal');
  const fourth = missions.list('f1')[3];
  assert.equal(fourth.status, 'running');
  const blk = engine.missionBlocked('h1', 'missing credentials');
  assert.equal(blk.ok, true);
  assert.equal(missions.get(fourth.id).status, 'blocked');
  assert.equal(missions.get(fourth.id).blockReason, 'missing credentials');

  // review path: folder with a branch that has committed changes
  m.folders.get('f1').isGit = true;
  m.folders.get('f1').wtm = {
    list: () => [{ id: 'w1', branch: 'agent/w1', path: '/x' }],
    diff: async () => ({ branch: 'agent/w1', patch: '+ real change', dirty: false }),
  };
  engine.addMission('f1', 'fifth goal');
  const fifth = missions.list('f1')[4];
  assert.equal(fifth.status, 'running');
  const rev = await engine.missionDone('h1', 'branch ready');
  assert.equal(rev.status, 'awaiting_review', 'branches → awaiting_review (Supervised)');
  assert.equal(missions.get(fifth.id).branches.length, 1);

  // watchdog: assigned HEAD dies while a mission runs
  missions.setStatus(fifth.id, 'done'); // clear the gate
  engine.addMission('f1', 'sixth goal');
  const sixth = missions.list('f1')[5];
  assert.equal(sixth.status, 'running');
  m.pty._exit('h1', 137);
  assert.equal(missions.get(sixth.id).status, 'blocked', 'watchdog blocks on agent exit');
  assert.ok(/exited/.test(missions.get(sixth.id).blockReason));

  // digest counts what happened
  const digest = runlog.digest(0);
  assert.ok(digest.missionsDone >= 1, 'digest counts done missions');
  assert.ok(digest.missionsBlocked >= 4, 'digest counts blocked missions (incl. watchdog)');
  assert.ok(digest.agentExits >= 1, 'digest counts watchdog agent exits');
  assert.ok(digest.needsYou.length >= 1, 'digest surfaces needs-you items');

  engine.stop();
  console.log('✓ engine transitions (topology, start, done/blocked/review, watchdog, digest) OK');

  // ---- open mesh: topology gate satisfied without any wires ------------------
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'am-autopilot3-'));
  const m2 = makeMocks();
  const missions2 = new MissionStore(tmp3);
  const runlog2 = new RunLog(tmp3);
  const engine2 = new AutopilotEngine({ stateDir: tmp3, missions: missions2, runlog: runlog2, pty: m2.pty, router: m2.router, guard: m2.guard, folders: m2.folders });
  engine2.setState({ autopilotOn: true, mode: 'supervised' });
  m2.pty._add({ id: 'h2', role: 'head', folderId: 'f1' });
  m2.pty._add({ id: 'w2', role: 'worker', folderId: 'f1' });
  engine2.addMission('f1', 'strict goal');
  assert.equal(missions2.list('f1')[0].status, 'blocked', 'strict mode still blocks unwired');
  assert.ok(/both directions/.test(missions2.list('f1')[0].blockReason));
  m2.router.openMesh = true;
  engine2.addMission('f1', 'open mesh goal');
  const om = missions2.list('f1')[1];
  assert.equal(om.status, 'running', 'open mesh satisfies the topology gate');
  assert.equal(om.assigneeHead, 'h2');
  assert.ok(m2.routed.find((r) => r.to === 'h2' && /open mesh goal/.test(r.message)), 'goal routed to HEAD');
  engine2.stop();
  console.log('✓ open mesh topology gate OK');

  console.log('\nAUTOPILOT TESTS PASSED ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
