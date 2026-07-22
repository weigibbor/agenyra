'use strict';
// Headless test for the guardrails (max exchanges, loop detection, human exempt).
// Run with:  node test/guard.js
const assert = require('assert');
const { Guard } = require('../main/guard');
const { Router } = require('../main/router');

// --- Guard: counting + max exchanges ---------------------------------------
const g = new Guard();
let c = g.check('t2', 't1', 'hello');
assert.ok(c.allow);
g.record('t2', c.key);
assert.equal(g.stats().total, 1);

g.setMax(3);
c = g.check('t2', 't1', 'a'); assert.ok(c.allow); g.record('t2', c.key); // 2
c = g.check('t2', 't1', 'b'); assert.ok(c.allow); g.record('t2', c.key); // 3
c = g.check('t2', 't1', 'c'); assert.equal(c.allow, false, 'capped at max'); // 3 >= 3
assert.equal(g.stats().paused, true, 'auto-paused at cap');
g.setMax(0); // unlimited clears the pause
assert.equal(g.stats().max, null);
assert.equal(g.stats().paused, false);
console.log('✓ max-exchange cap + auto-pause OK');

// --- Guard: loop detection --------------------------------------------------
const g2 = new Guard();
let k = g2.check('a', 'b', 'same'); assert.ok(k.allow); g2.record('a', k.key);
k = g2.check('a', 'b', 'same'); assert.ok(k.allow); g2.record('a', k.key);
k = g2.check('a', 'b', 'same'); assert.equal(k.allow, false, 'repeated message -> loop');
assert.equal(g2.stats().paused, true, 'loop auto-paused');
console.log('✓ loop detection OK');

// --- Router integration: human exempt, agents counted + capped -------------
const written = [];
const mockPty = {
  panes: new Map([['t1', { id: 't1', role: 'head' }], ['t2', { id: 't2', role: 'worker' }]]),
  get(id) { return this.panes.get(id); },
  has(id) { return this.panes.has(id); },
  write(id, d) { written.push({ id, d }); },
};
const g3 = new Guard();
g3.setMax(1);
const r = new Router(mockPty, g3);
r.addWire('t1', 't2'); // AM-FEAT-005: routes are strictly directed — wire explicitly

assert.equal(r.route('human', 't2', 'hi').ok, true, 'human always allowed');
assert.equal(g3.stats().total, 0, 'human messages are not counted');

assert.equal(r.route('t1', 't2', 'go').ok, true, 'first agent message allowed');
assert.equal(g3.stats().total, 1);

const blocked = r.route('t1', 't2', 'again');
assert.equal(blocked.ok, false, 'agent message over cap blocked');
assert.equal(blocked.guard, true, 'blocked by guard');
assert.equal(g3.stats().paused, true);
console.log('✓ router guard integration (human exempt, agents capped) OK');

console.log('\nGUARD TESTS PASSED ✅');
process.exit(0);
