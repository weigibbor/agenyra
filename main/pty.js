'use strict';
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
// @lydell/node-pty ships prebuilt binaries for Node and Electron, so there is
// no native compile step (no Visual Studio C++ toolset required). Drop-in API.
const pty = require('@lydell/node-pty');

const isWin = process.platform === 'win32';
const DEFAULT_SHELL = isWin ? 'powershell.exe' : process.env.SHELL || 'bash';

// Maps an agent-type preset to the command that launches it in a pane.
// For the MVP these all fall back to a shell; the human runs `claude`/`codex`
// inside it. Phase 3 wires the real CLIs directly.
const AGENT_PRESETS = {
  shell: { cmd: DEFAULT_SHELL, args: [] },
  claude: { cmd: DEFAULT_SHELL, args: [] },
  codex: { cmd: DEFAULT_SHELL, args: [] },
  grok: { cmd: DEFAULT_SHELL, args: [] },
  aider: { cmd: DEFAULT_SHELL, args: [] },
};

// Spawns and tracks one real pseudo-terminal per pane. Each pane is its own
// OS process, so work runs truly in parallel across panes.
class PtyManager extends EventEmitter {
  constructor({ busPort, binDir, token }) {
    super();
    this.panes = new Map(); // id -> { pty, id, agentType, role, cwd }
    this.busPort = busPort;
    this.binDir = binDir;
    this.token = token || null; // per-session bus secret, injected as MESH_TOKEN
  }

  setBusPort(port) {
    this.busPort = port;
  }

  // Phase 5 settings: override the platform default shell (empty = default).
  setDefaultShell(shell) {
    this.defaultShell = String(shell || '').trim() || null;
  }

  create(id, opts = {}) {
    if (this.panes.has(id)) throw new Error(`pane "${id}" already exists`);
    const agentType = opts.agentType || 'shell';
    const preset = this.defaultShell
      ? { cmd: this.defaultShell, args: [] }
      : (AGENT_PRESETS[agentType] || AGENT_PRESETS.shell);
    const cwd = opts.cwd || os.homedir();

    const env = Object.assign({}, process.env);
    // Put `mesh` on PATH and tell it who/where to talk to. On Windows the
    // variable's own-key can be `Path` (any casing) — the copied plain object
    // is case-sensitive, so blindly setting `PATH` would create a SECOND key
    // while the OS resolves the original, silently dropping `mesh` off PATH.
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = this.binDir + path.delimiter + (env[pathKey] || '');
    env.MESH_PANE = id;
    env.MESH_PORT = String(this.busPort || '');
    env.MESH_TOKEN = this.token || '';

    const p = pty.spawn(preset.cmd, preset.args, {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd,
      env,
    });

    p.onData((data) => this.emit('data', { id, data }));
    p.onExit(({ exitCode }) => {
      this.panes.delete(id);
      this.emit('exit', { id, exitCode });
    });

    this.panes.set(id, {
      pty: p,
      id,
      agentType,
      role: opts.role || 'worker',
      cwd,
      folderId: opts.folderId || null,
      parentId: opts.parentId || null,          // hierarchy only — never implies a route
      activationPolicy: opts.activationPolicy || 'manual',
      createdAt: Date.now(),                    // cost engine scans transcripts from here
      restored: !!opts.restored,                // session-restored pane (renderer relaunches the CLI)
      canContinue: !!opts.canContinue,          // a real transcript exists → claude --continue is safe
      effort: opts.effort || null,              // app-set reasoning effort (authoritative; shown in header)
      utility: !!opts.utility,                  // scratch shell (Code view terminal) — not an agent
    });
    return { id, agentType, cwd };
  }

  write(id, data) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    // The pane's OS process can die between the get() above and this write
    // (node-pty throws EIO/EPIPE). This runs inside timer/bus callbacks, so an
    // unguarded throw would take down the whole main process.
    try {
      pane.pty.write(data);
    } catch (_) {
      return false;
    }
    return true;
  }

  resize(id, cols, rows) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    try {
      pane.pty.resize(cols, rows);
    } catch (_) {
      /* pane may have exited */
    }
    return true;
  }

  kill(id) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    try {
      pane.pty.kill();
    } catch (_) {}
    this.panes.delete(id);
    return true;
  }

  // Kill every live pane. Called on app quit so no shell/agent process is left
  // orphaned — Windows ConPTY children don't reliably die with the parent, and
  // a stale process holds locks on its worktree that break the next launch.
  killAll() {
    for (const pane of this.panes.values()) {
      try { pane.pty.kill(); } catch (_) {}
    }
    this.panes.clear();
  }

  // Send Ctrl-C to every pane to interrupt whatever is running (emergency stop).
  interruptAll() {
    for (const pane of this.panes.values()) {
      try {
        pane.pty.write('\x03');
      } catch (_) {}
    }
  }

  // HEAD is a user-assignable role, not a singleton (AM-FEAT-005): zero, one,
  // or many HEADs are valid, so promotion never demotes another terminal.
  setRole(id, role) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    pane.role = role;
    return true;
  }

  // Parent hierarchy is organizational only and independent from wires.
  // Rejects self-parenting and descendant cycles.
  setParent(id, parentId) {
    const pane = this.panes.get(id);
    if (!pane) return { ok: false, error: 'no such pane' };
    if (!parentId) { pane.parentId = null; return { ok: true }; }
    if (parentId === id) return { ok: false, error: 'a terminal cannot parent itself' };
    if (!this.panes.has(parentId)) return { ok: false, error: 'parent does not exist' };
    // walk up from the candidate parent — if we reach id, it's a cycle
    let cur = this.panes.get(parentId);
    const seen = new Set();
    while (cur && cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.parentId === id) return { ok: false, error: 'parent cycle' };
      cur = this.panes.get(cur.parentId);
    }
    pane.parentId = parentId;
    return { ok: true };
  }

  setActivation(id, policy) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    if (['manual', 'immediate', 'on_parent_handoff'].indexOf(policy) === -1) return false;
    pane.activationPolicy = policy;
    return true;
  }

  // The HEAD pane; scoped to a folder when a folderId is given.
  getHeadId(folderId) {
    for (const pane of this.panes.values()) {
      if (pane.role === 'head' && (folderId === undefined || pane.folderId === folderId)) return pane.id;
    }
    return null;
  }

  get(id) {
    return this.panes.get(id);
  }

  has(id) {
    return this.panes.has(id);
  }

  list() {
    // Utility scratch shells (Code-view terminal) are not agents — hidden from
    // the sidebar, mesh, cost, watchdog, and session by omitting them here.
    return [...this.panes.values()].filter((p) => !p.utility).map(({ id, agentType, role, cwd, folderId, parentId, activationPolicy, restored, canContinue, effort }) => ({
      id,
      agentType,
      role,
      cwd,
      folderId,
      parentId,
      activationPolicy,
      restored,
      canContinue,
      effort,
    }));
  }

  // App-set effort change (header dropdown) — kept authoritative on the record.
  setEffort(id, effort) {
    const p = this.panes.get(id);
    if (p) p.effort = effort || null;
  }
}

module.exports = { PtyManager, AGENT_PRESETS, DEFAULT_SHELL };
