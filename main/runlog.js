'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { writeFileAtomic } = require('./atomic');

const ROTATE_BYTES = 4 * 1024 * 1024; // trim once the log passes ~4 MB
const ROTATE_KEEP = 5000;             // …down to the most recent 5000 events
const ROTATE_EVERY = 500;             // check size only every N appends (statSync is cheap but not free)

// Phase 4B: the persistent run timeline. Append-only JSONL so an overnight run
// survives restarts and the Morning Digest can be computed from real history.
// Event: { ts, type, folderId?, missionId?, data? }
class RunLog extends EventEmitter {
  constructor(stateDir) {
    super();
    this.file = path.join(stateDir, 'runlog.jsonl');
    try { fs.mkdirSync(stateDir, { recursive: true }); } catch (_) {}
  }

  add(type, fields) {
    const ev = Object.assign({ ts: Date.now(), type }, fields || {});
    try {
      fs.appendFileSync(this.file, JSON.stringify(ev) + '\n');
      if ((this._appends = (this._appends || 0) + 1) >= ROTATE_EVERY) { this._appends = 0; this._rotateIfLarge(); }
    } catch (e) {
      console.log(`[autopilot] runlog append failed: ${e.message}`);
    }
    this.emit('event', ev);
    return ev;
  }

  // Append-only JSONL grows without bound over days of overnight runs, and both
  // list() and digest() readFileSync the whole thing. Cap it: past ~4 MB, keep
  // only the most recent ROTATE_KEEP events (atomic rewrite so a crash mid-rotate
  // can't corrupt the log).
  _rotateIfLarge() {
    try {
      if (fs.statSync(this.file).size < ROTATE_BYTES) return;
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= ROTATE_KEEP) return;
      writeFileAtomic(this.file, lines.slice(-ROTATE_KEEP).join('\n') + '\n');
    } catch (_) { /* best-effort */ }
  }

  list({ sinceTs = 0, limit = 200 } = {}) {
    let lines;
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n'); } catch (_) { return []; }
    const out = [];
    // newest-last file; walk from the end so big logs stay cheap
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const ln = lines[i].trim();
      if (!ln) continue;
      try {
        const ev = JSON.parse(ln);
        if (ev.ts >= sinceTs) out.push(ev); else break;
      } catch (_) { /* skip torn line */ }
    }
    return out.reverse();
  }

  // The Morning Digest: everything that happened since the user last looked.
  digest(sinceTs) {
    const events = this.list({ sinceTs: sinceTs || 0, limit: 2000 });
    const d = {
      sinceTs: sinceTs || 0,
      firstTs: events.length ? events[0].ts : null,
      lastTs: events.length ? events[events.length - 1].ts : null,
      missionsDone: 0,
      missionsBlocked: 0,
      merges: 0,
      rollbacks: 0,
      guardPauses: 0,
      officerVerdicts: 0,
      agentExits: 0,
      needsYou: [], // [{missionId, folderId, reason}]
    };
    const needs = {}; // missionId -> latest needs-you entry
    events.forEach((ev) => {
      if (ev.type === 'mission.done') d.missionsDone++;
      else if (ev.type === 'mission.blocked') { d.missionsBlocked++; needs[ev.missionId] = { missionId: ev.missionId, folderId: ev.folderId, reason: (ev.data && ev.data.reason) || 'blocked' }; }
      else if (ev.type === 'mission.review') needs[ev.missionId] = { missionId: ev.missionId, folderId: ev.folderId, reason: 'needs merge approval' };
      else if (ev.type === 'mission.merged') { d.merges++; delete needs[ev.missionId]; }
      else if (ev.type === 'mission.rolledback') d.rollbacks++;
      else if (ev.type === 'guard.paused') d.guardPauses++;
      else if (ev.type === 'officer.verdict') d.officerVerdicts++;
      else if (ev.type === 'watchdog.agent_exit') d.agentExits++;
      else if (ev.type === 'mission.done_resolved') delete needs[ev.missionId];
    });
    d.needsYou = Object.keys(needs).map((k) => needs[k]);
    return d;
  }
}

module.exports = { RunLog };
