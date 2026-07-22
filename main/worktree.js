'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

function git(repoPath, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoPath, maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

// Gives each worker its own git worktree (isolated checkout + branch) so parallel
// edits never collide. The HEAD works in the main repo and alone merges branches
// back. Worktrees live in a sibling folder so they never pollute the repo's status.
class WorktreeManager {
  constructor(repoPath) {
    this.setRepo(repoPath || null);
  }

  setRepo(repoPath) {
    this.repoPath = repoPath;
    this.baseBranch = 'HEAD';
    this.worktrees = new Map(); // id -> { path, branch, baseSha }
  }

  worktreesRoot() {
    return path.join(path.dirname(this.repoPath), path.basename(this.repoPath) + '.worktrees');
  }

  async isGitRepo() {
    if (!this.repoPath) return false;
    try {
      const r = await git(this.repoPath, ['rev-parse', '--is-inside-work-tree']);
      return r.trim() === 'true';
    } catch (_) {
      return false;
    }
  }

  // Capture the repo's current branch so diffs/merges have a stable base.
  async init() {
    if (!(await this.isGitRepo())) return false;
    try {
      this.baseBranch = (await git(this.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
    } catch (_) {
      this.baseBranch = 'HEAD';
    }
    return true;
  }

  async create(id) {
    const branch = `agent/${id}`;
    const wtPath = path.join(this.worktreesRoot(), id);
    // Clean any stale worktree/branch left by a previous run or hard restart,
    // so a freshly-spawned agent always gets a clean, isolated worktree.
    await git(this.repoPath, ['worktree', 'prune']).catch(() => {});
    await git(this.repoPath, ['worktree', 'remove', '--force', wtPath]).catch(() => {});
    // Async so a large stale checkout (node_modules etc.) doesn't freeze the main
    // process/UI on every worker spawn.
    await fs.promises.rm(wtPath, { recursive: true, force: true }).catch(() => {});
    await git(this.repoPath, ['branch', '-D', branch]).catch(() => {});

    const baseSha = (await git(this.repoPath, ['rev-parse', 'HEAD'])).trim();
    await git(this.repoPath, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
    const info = { path: wtPath, branch, baseSha };
    this.worktrees.set(id, info);
    return info;
  }

  // Non-destructive reattach for session restore (Phase 5). NEVER deletes a
  // branch or directory (unlike create's stale-cleanup): if the worktree dir
  // still exists → just remap it; if only the branch survives → check it out
  // into a fresh worktree; if neither exists → returns null (caller decides).
  async adopt(id) {
    const branch = `agent/${id}`;
    const wtPath = path.join(this.worktreesRoot(), id);
    const branchExists = await git(this.repoPath, ['rev-parse', '--verify', branch])
      .then(() => true, () => false);
    if (fs.existsSync(path.join(wtPath, '.git'))) {
      const info = { path: wtPath, branch, baseSha: null };
      this.worktrees.set(id, info);
      return info;
    }
    if (branchExists) {
      await git(this.repoPath, ['worktree', 'prune']).catch(() => {});
      await git(this.repoPath, ['worktree', 'add', wtPath, branch]);
      const info = { path: wtPath, branch, baseSha: null };
      this.worktrees.set(id, info);
      return info;
    }
    return null;
  }

  get(id) {
    return this.worktrees.get(id);
  }

  // Uncommitted state inside a worker's worktree (for the "dirty" warning).
  async status(id) {
    const info = this.worktrees.get(id);
    if (!info) return { clean: true, detail: '' };
    const s = await git(info.path, ['status', '--porcelain']);
    return { clean: s.trim() === '', detail: s };
  }

  // Committed changes on the worker's branch, relative to the base branch.
  async diff(id) {
    const info = this.worktrees.get(id);
    if (!info) throw new Error(`no worktree for ${id}`);
    const range = `${this.baseBranch}...${info.branch}`;
    const stat = await git(this.repoPath, ['diff', '--stat', range]);
    const patch = await git(this.repoPath, ['diff', range]);
    const status = await this.status(id);
    return { branch: info.branch, stat: stat.trim(), patch, dirty: !status.clean };
  }

  // HEAD-only: merge a worker's branch into the base branch (main repo tree).
  async merge(id) {
    const info = this.worktrees.get(id);
    if (!info) throw new Error(`no worktree for ${id}`);
    const output = await git(this.repoPath, ['merge', '--no-ff', '-m', `merge ${info.branch}`, info.branch]);
    return { ok: true, output: output.trim() };
  }

  async remove(id, force = false) {
    const info = this.worktrees.get(id);
    if (!info) return { ok: true, removed: false };
    if (!force) {
      const status = await this.status(id);
      if (!status.clean) return { ok: false, error: 'uncommitted changes', dirty: true };
    }
    const args = ['worktree', 'remove', info.path];
    if (force) args.push('--force');
    await git(this.repoPath, args);
    this.worktrees.delete(id);
    return { ok: true, removed: true };
  }

  list() {
    return [...this.worktrees.entries()].map(([id, w]) => ({ id, branch: w.branch, path: w.path }));
  }
}

module.exports = { WorktreeManager, git };
