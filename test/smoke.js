'use strict';
// Headless smoke test for the pure-JS backend — no Electron / node-pty needed.
// Run with:  node test/smoke.js
const assert = require('assert');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { Coordinator } = require('../main/coordinator');
const { Router } = require('../main/router');
const { Guard } = require('../main/guard');
const { Bus } = require('../main/bus');

// ---- Coordinator: task board + atomic claim -------------------------------
const c = new Coordinator();
const t1 = c.addTask('login', ['read auth', 'endpoint']);
const t2 = c.addTask('signup');
assert.equal(c.listTasks().length, 2);

const claimed = c.claimTask('t2');
assert.equal(claimed.id, t1.id, 'claims the first TODO');
assert.equal(claimed.assignee, 't2');
const claimed2 = c.claimTask('t3');
assert.equal(claimed2.id, t2.id, 'second agent gets the next TODO');
assert.equal(c.claimTask('t4'), null, 'no double-claim: nothing left');

// ---- Live progress --------------------------------------------------------
c.addStep('t2', 'add validation');
c.startStep('t2', 'endpoint');
c.doneStep('t2', 'read auth');
c.setActivity('t2', 'writing tests');
c.setLocation('t2', 'src/auth/login.js');
const task = c.listTasks().find((x) => x.id === t1.id);
assert.equal(task.activity, 'writing tests');
assert.equal(task.location, 'src/auth/login.js');
assert.equal(task.steps.find((s) => s.label === 'read auth').status, 'done');
assert.equal(task.steps.find((s) => s.label === 'endpoint').status, 'active');

// ---- Resource locks: mutual exclusion + waiter promotion ------------------
assert.deepEqual(c.acquireLock('t2', 'smoke-test'), { ok: true, held: true, holder: 't2' });
const busy = c.acquireLock('t3', 'smoke-test');
assert.equal(busy.ok, false, 'lock held -> busy');
assert.equal(busy.waiting, true, 't3 is queued');
const rel = c.releaseLock('t2', 'smoke-test');
assert.equal(rel.grantedTo, 't3', 'waiter promoted on release');

// ---- Router: wire enforcement (with a mock PTY manager) -------------------
const written = [];
const mockPty = {
  panes: new Map([
    ['head', { id: 'head', role: 'head', folderId: 'f1' }],
    ['t2', { id: 't2', role: 'worker', folderId: 'f1' }],
    ['t3', { id: 't3', role: 'worker', folderId: 'f1' }],
    ['wb', { id: 'wb', role: 'worker', folderId: 'f1', utility: true }], // scratch shell
    ['x9', { id: 'x9', role: 'worker', folderId: 'f2' }], // another folder
  ]),
  get(id) {
    return this.panes.get(id);
  },
  has(id) {
    return this.panes.has(id);
  },
  write(id, data) {
    written.push({ id, data });
    return true;
  },
  list() {
    return [...this.panes.values()];
  },
};
const r = new Router(mockPty);
// AM-FEAT-005: routes are strictly directed — HEAD is a role, not a bypass.
assert.equal(r.route('head', 't2', 'do X').ok, false, 'unwired HEAD blocked too');
r.addWire('head', 't2');
assert.equal(r.route('head', 't2', 'do X').ok, true, 'wired HEAD->t2 allowed');
assert.equal(r.route('t2', 'head', 'done').ok, false, 'reverse direction needs its own wire');
assert.equal(r.route('t2', 't3', 'hi').ok, false, 'unwired worker->worker blocked');
r.addWire('t2', 't3');
assert.equal(r.route('t2', 't3', 'hi').ok, true, 'wired worker->worker allowed');
assert.equal(written.filter((w) => w.id === 't3').length, 1, 'message delivered to t3 pty');

console.log('✓ coordinator + router logic OK');

// ---- Router: open mesh — unlimited send/receive within a folder -----------
// Separate Router instances so `r` above keeps strict semantics for the Bus
// tests. The bypass must NOT bypass the guard, utility panes, or folders.
const gm = new Guard();
const rm = new Router(mockPty, gm);
rm.openMesh = true;
assert.equal(rm.route('t3', 't2', 'ping').ok, true, 'open mesh: unwired t3->t2 allowed');
assert.equal(rm.route('t2', 't3', 'pong').ok, true, 'open mesh: reverse allowed, zero wires');
assert.equal(gm.stats().total, 2, 'guard still counts open-mesh traffic');
const rmLoop = new Router(mockPty, new Guard());
rmLoop.openMesh = true;
rmLoop.route('t2', 't3', 'same');
rmLoop.route('t2', 't3', 'same');
assert.equal(rmLoop.route('t2', 't3', 'same').ok, false, 'open mesh: loop detection still pauses');
const rmScope = new Router(mockPty);
rmScope.openMesh = true;
assert.equal(rmScope.route('t2', 'wb', 'hi').ok, false, 'open mesh: utility pane still blocked');
assert.equal(rmScope.route('t2', 'x9', 'hi').ok, false, 'open mesh: cross-folder still blocked');
rmScope.openMesh = false;
assert.equal(rmScope.route('t2', 't3', 'hi').ok, false, 'toggle off restores strict blocking');

console.log('✓ open mesh routing OK');

// ---- Bus + real mesh CLI end-to-end ---------------------------------------
const bus = new Bus({ router: r, coordinator: c, ptyManager: mockPty });
bus.start().then(async (port) => {
  // Hardening (Phase 4B): the bus must reject forged system senders and
  // unknown panes — otherwise an agent could bypass wires + the guard.
  const post = (body) => fetch(`http://127.0.0.1:${port}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const forged = await post({ from: 'human', to: 't2', message: 'forged' });
  assert.equal(forged.status, 403, 'bus rejects forged "human" sender');
  const auto = await post({ from: 'autopilot', to: 't2', message: 'forged' });
  assert.equal(auto.status, 403, 'bus rejects forged "autopilot" sender');
  const ghost = await post({ from: 'ghost', to: 't2', message: 'hi' });
  assert.equal(ghost.status, 403, 'bus rejects unknown pane senders');
  console.log('✓ bus sender hardening OK');

  const meshJs = path.join(__dirname, '..', 'bin', 'mesh.js');
  const env = Object.assign({}, process.env, { MESH_PORT: String(port), MESH_PANE: 'head' });
  execFile(process.execPath, [meshJs, 'task', 'add', 'via cli'], { env }, (err) => {
    assert.ifError(err);
    assert.ok(
      c.listTasks().some((t) => t.title === 'via cli'),
      'task added through the real mesh CLI -> bus -> coordinator'
    );
    console.log('✓ bus + mesh CLI end-to-end OK');
    bus.stop();
    securedBusTest().then(() => {
      console.log('\nALL SMOKE TESTS PASSED ✅');
    }).catch((e) => { console.error('✗ secured bus test failed:', e); process.exit(1); });
  });
});

// ---- Bus security gate: token + host + origin + content-type + body cap -----
// Resolves (never rejects) so an intentional connection reset on the oversized
// case is observable rather than crashing the harness.
function rawPost(port, pathname, body, headers) {
  return new Promise((resolve) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST', agent: false, // fresh socket (no pool reuse after a server-side destroy)
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        headers || {}
      ),
    }, (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: o })); });
    req.on('error', (e) => resolve({ status: 0, error: e.code || 'ERR' }));
    if (data) req.write(data);
    req.end();
  });
}
function rawGet(port, pathname, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', agent: false, headers: headers || {} },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (e) => resolve(0));
    req.end();
  });
}
// Runs the REAL bin/mesh.js subprocess (as a pane would) against the bus, so the
// token round-trip is proven end-to-end, not just via a hand-built request.
function runCli(port, token, args) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { MESH_PORT: String(port), MESH_PANE: 'head' });
    if (token != null) env.MESH_TOKEN = token; else delete env.MESH_TOKEN;
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'mesh.js'), ...args], { env }, (err) => {
      resolve(err ? (err.code || 1) : 0);
    });
  });
}
async function securedBusTest() {
  const TOKEN = 'test-secret-token-abc';
  const sbus = new Bus({ router: r, coordinator: c, ptyManager: mockPty, token: TOKEN });
  const port = await sbus.start();
  const send = (headers, body) => rawPost(port, '/send', body || { from: 'head', to: 't2', message: 'hi' }, headers);

  assert.equal((await send({ 'X-Mesh-Token': TOKEN })).status, 200, 'valid token + known sender accepted');
  assert.equal((await send({})).status, 403, 'missing token rejected');
  assert.equal((await send({ 'X-Mesh-Token': 'wrong' })).status, 403, 'wrong token rejected');
  assert.equal((await send({ 'X-Mesh-Token': TOKEN, Origin: 'https://evil.example' })).status, 403, 'browser Origin (CSRF) rejected even with token');
  assert.equal((await send({ 'X-Mesh-Token': TOKEN, Host: 'evil.example' })).status, 403, 'rebinding Host rejected');
  assert.equal((await rawPost(port, '/send', JSON.stringify({ from: 'head', to: 't2', message: 'hi' }), { 'X-Mesh-Token': TOKEN, 'Content-Type': 'text/plain' })).status, 415, 'non-JSON content-type rejected (blocks CORS simple-request forgery)');
  const over = await send({ 'X-Mesh-Token': TOKEN }, { from: 'head', to: 't2', message: 'x'.repeat(1024 * 1024 + 32) });
  assert.ok(over.status === 413 || over.status === 0, 'oversized body rejected (413 or connection torn), got ' + over.status);
  assert.equal(await rawGet(port, '/panes', { 'X-Mesh-Token': TOKEN }), 200, 'GET with token allowed');
  assert.equal(await rawGet(port, '/panes', {}), 403, 'GET without token rejected (topology recon blocked)');
  // Real mesh CLI subprocess: token injected via env passes; no token fails.
  assert.equal(await runCli(port, TOKEN, ['status', 'working']), 0, 'real mesh CLI with MESH_TOKEN succeeds');
  assert.notEqual(await runCli(port, null, ['status', 'working']), 0, 'real mesh CLI without MESH_TOKEN is rejected');
  sbus.stop();
  console.log('✓ bus security gate (token + host + origin + content-type + body cap + real CLI) OK');
}
