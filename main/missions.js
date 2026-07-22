'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { writeFileAtomic } = require('./atomic');

// Phase 4B: the persistent mission queue. A mission is a goal the Autopilot
// engine hands to a folder's HEAD; it survives restarts on disk. Statuses:
//   queued → running → awaiting_review → merging → done
//                    ↘ blocked                    ↘ rolled_back (after done)
// The store is deterministic bookkeeping only — the engine owns transitions.
const STATUSES = ['queued', 'running', 'awaiting_review', 'merging', 'done', 'blocked', 'rolled_back'];

class MissionStore extends EventEmitter {
  constructor(stateDir) {
    super();
    this.file = path.join(stateDir, 'missions.json');
    this.missions = [];
    this.seq = 0;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data.missions)) this.missions = data.missions;
      this.seq = data.seq || this.missions.length;
    } catch (e) {
      console.log(`[autopilot] missions load failed: ${e.message}`);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify({ seq: this.seq, missions: this.missions }, null, 2));
    } catch (e) {
      console.log(`[autopilot] missions save failed: ${e.message}`);
    }
    this.emit('change', this.list());
  }

  add(folderId, goal) {
    const goalText = String(goal || '').trim();
    if (!folderId || !goalText) return { ok: false, error: 'folderId and goal required' };
    const m = {
      id: 'M' + ++this.seq,
      folderId,
      goal: goalText,
      status: 'queued',
      assigneeHead: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      blockReason: null,
      branches: [],       // [{agentId, branch}] candidates at review time
      checkpoint: null,   // {sha, tag}
      mergeCommits: [],   // one per merged branch
      summary: null,
    };
    this.missions.push(m);
    this._save();
    return { ok: true, mission: m };
  }

  remove(id) {
    const m = this.get(id);
    if (!m) return { ok: false, error: 'no such mission' };
    if (m.status === 'running' || m.status === 'merging') return { ok: false, error: 'mission is active' };
    this.missions = this.missions.filter((x) => x.id !== id);
    this._save();
    return { ok: true };
  }

  get(id) {
    return this.missions.find((m) => m.id === id) || null;
  }

  list(folderId) {
    return folderId ? this.missions.filter((m) => m.folderId === folderId) : this.missions.slice();
  }

  // The engine's dequeue: the oldest queued mission for a folder, but only if
  // nothing in that folder is already active (per-folder serialization).
  nextFor(folderId) {
    const active = this.missions.some(
      (m) => m.folderId === folderId && ['running', 'awaiting_review', 'merging'].indexOf(m.status) !== -1
    );
    if (active) return null;
    return this.missions.find((m) => m.folderId === folderId && m.status === 'queued') || null;
  }

  activeFor(folderId) {
    return this.missions.find(
      (m) => m.folderId === folderId && ['running', 'awaiting_review', 'merging'].indexOf(m.status) !== -1
    ) || null;
  }

  setStatus(id, status, patch) {
    if (STATUSES.indexOf(status) === -1) return { ok: false, error: 'bad status' };
    const m = this.get(id);
    if (!m) return { ok: false, error: 'no such mission' };
    m.status = status;
    if (status === 'running' && !m.startedAt) m.startedAt = Date.now();
    if (status === 'done' || status === 'blocked') m.finishedAt = Date.now();
    Object.assign(m, patch || {});
    this._save();
    return { ok: true, mission: m };
  }

  // On boot: a mission left running/merging by a previous process was
  // interrupted — surface it instead of silently re-running (engine decision).
  markInterrupted() {
    let n = 0;
    this.missions.forEach((m) => {
      if (m.status === 'running' || m.status === 'merging') {
        m.status = 'blocked';
        m.blockReason = 'interrupted (app restart)';
        m.finishedAt = Date.now();
        n++;
      }
    });
    if (n) this._save();
    return n;
  }
}

module.exports = { MissionStore, STATUSES };
