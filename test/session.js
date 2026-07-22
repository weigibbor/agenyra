'use strict';
// Phase 5 session tests: spec persistence round-trips, and — critically — the
// worktree ADOPT path never destroys a branch or its commits (unlike create's
// stale-cleanup, which is exactly why restore must not go through create).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SessionStore } = require('../main/session');
const { WorktreeManager } = require('../main/worktree');

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

async function main() {
  // ---- SessionStore round-trip ----------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-session-'));
  const store = new SessionStore(dir);
  const specs = [
    { id: 't1', agentType: 'claude', role: 'head', folderId: 'f1', parentId: null, activationPolicy: 'manual', branch: null, worktreePath: null },
    { id: 't2', agentType: 'codex', role: 'worker', folderId: 'f1', parentId: 't1', activationPolicy: 'on_parent_handoff', branch: 'agent/t2', worktreePath: 'X' },
  ];
  store.savePanes(specs);
  store.saveWires([{ from: 't1', to: 't2' }, { from: 't2', to: 't1' }]);
  const store2 = new SessionStore(dir);
  assert.deepEqual(store2.loadPanes(), specs, 'pane specs round-trip');
  assert.equal(store2.loadWires().length, 2, 'wires round-trip');
  console.log('✓ session store round-trip OK');

  // ---- adopt() never destroys work ------------------------------------------
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-adopt-repo-'));
  sh(repo, 'git', ['init', '-q']);
  sh(repo, 'git', ['config', 'user.email', 't@t']);
  sh(repo, 'git', ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-qm', 'base']);

  const wtm = new WorktreeManager(repo);
  await wtm.init();
  const wt = await wtm.create('t9');
  fs.writeFileSync(path.join(wt.path, 'work.txt'), 'precious agent work\n');
  sh(wt.path, 'git', ['add', '-A']);
  sh(wt.path, 'git', ['commit', '-qm', 'agent work']);
  const workSha = sh(wt.path, 'git', ['rev-parse', 'HEAD']).trim();

  // Simulate an app restart: a brand-new manager with an empty in-memory map.
  const wtm2 = new WorktreeManager(repo);
  await wtm2.init();
  assert.equal(wtm2.get('t9'), undefined, 'fresh manager has no mapping (the restart hazard)');

  // Case 1: worktree dir still on disk → adopt remaps, commit survives.
  const adopted = await wtm2.adopt('t9');
  assert.ok(adopted && adopted.path === wt.path, 'adopt remapped the existing worktree');
  const shaAfter = sh(adopted.path, 'git', ['rev-parse', 'HEAD']).trim();
  assert.equal(shaAfter, workSha, 'adopt kept the agent commit (create would have nuked it)');

  // Case 2: dir gone but the branch survives → adopt checks the branch out again.
  sh(repo, 'git', ['worktree', 'remove', '--force', adopted.path]);
  const wtm3 = new WorktreeManager(repo);
  await wtm3.init();
  const readopted = await wtm3.adopt('t9');
  assert.ok(readopted, 'adopt recreated the worktree from the surviving branch');
  assert.equal(sh(readopted.path, 'git', ['rev-parse', 'HEAD']).trim(), workSha, 'commit still intact');

  // Case 3: nothing survives → adopt returns null (caller may then create fresh).
  sh(repo, 'git', ['worktree', 'remove', '--force', readopted.path]);
  sh(repo, 'git', ['branch', '-D', 'agent/t9']);
  const wtm4 = new WorktreeManager(repo);
  await wtm4.init();
  assert.equal(await wtm4.adopt('t9'), null, 'adopt refuses to invent state');

  console.log('✓ adopt() non-destructive restore semantics OK');
  console.log('\nSESSION TESTS PASSED ✅');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
