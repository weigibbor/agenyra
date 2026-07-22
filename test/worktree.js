'use strict';
// Headless test of the git-worktree flow against a throwaway repo.
// Run with:  node test/worktree.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { WorktreeManager } = require('../main/worktree');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-wt-'));
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

g(tmp, 'init', '-b', 'main');
g(tmp, 'config', 'user.email', 'test@example.com');
g(tmp, 'config', 'user.name', 'Test');
fs.writeFileSync(path.join(tmp, 'README.md'), '# base\n');
g(tmp, 'add', '-A');
g(tmp, 'commit', '-m', 'init');

(async () => {
  const wt = new WorktreeManager(tmp);
  assert.equal(await wt.init(), true, 'temp dir is a git repo');
  assert.equal(wt.baseBranch, 'main', 'base branch captured');

  // Worker w1 gets an isolated worktree + branch.
  const info = await wt.create('w1');
  assert.ok(fs.existsSync(info.path), 'worktree dir created');
  assert.equal(info.branch, 'agent/w1', 'branch name');

  // Worker makes a change and commits INSIDE its worktree.
  fs.writeFileSync(path.join(info.path, 'feature.txt'), 'hello from w1\n');
  g(info.path, 'add', '-A');
  g(info.path, 'commit', '-m', 'add feature');

  const d = await wt.diff('w1');
  assert.ok(/feature\.txt/.test(d.stat), 'diff shows feature.txt');
  assert.equal(d.dirty, false, 'clean after commit');

  // Isolation: the change is NOT in main yet.
  assert.equal(fs.existsSync(path.join(tmp, 'feature.txt')), false, 'isolated from main');

  // HEAD merges the worker branch.
  const m = await wt.merge('w1');
  assert.ok(m.ok, 'merge succeeded');
  assert.equal(fs.existsSync(path.join(tmp, 'feature.txt')), true, 'feature merged into main');
  console.log('✓ create -> commit -> diff -> isolation -> merge OK');

  // Dirty guard: uncommitted work blocks a non-forced remove.
  const info2 = await wt.create('w2');
  fs.writeFileSync(path.join(info2.path, 'wip.txt'), 'unsaved\n');
  const blocked = await wt.remove('w2');
  assert.equal(blocked.ok, false, 'dirty worktree blocks remove');
  assert.equal(blocked.dirty, true, 'reported as dirty');
  const forced = await wt.remove('w2', true);
  assert.ok(forced.ok && forced.removed, 'force remove works');
  console.log('✓ dirty-guard + force cleanup OK');

  // Cleanup w1.
  const r = await wt.remove('w1');
  assert.ok(r.ok, 'w1 removed');
  assert.equal(fs.existsSync(info.path), false, 'worktree dir gone');

  console.log('\nWORKTREE TESTS PASSED ✅');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
})().catch((e) => {
  console.error('FAILED:', e.message);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
