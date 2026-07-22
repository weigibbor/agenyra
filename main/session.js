'use strict';
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic');

// Phase 5: session persistence. Continuously mirrors the live pane specs and
// wires to disk so the whole mesh comes back after an app restart:
//   .state/panes.json  [{id, agentType, role, folderId, parentId,
//                        activationPolicy, branch, worktreePath}]
//   .state/wires.json  [{from, to}]
// Rules: explicit kill removes the spec (the user closed it on purpose);
// crash/exit KEEPS it (respawnable); app quit keeps everything.
class SessionStore {
  constructor(stateDir) {
    this.panesFile = path.join(stateDir, 'panes.json');
    this.wiresFile = path.join(stateDir, 'wires.json');
    try { fs.mkdirSync(stateDir, { recursive: true }); } catch (_) {}
  }

  _write(file, data) {
    try { writeFileAtomic(file, JSON.stringify(data, null, 2)); } catch (e) {
      console.log(`[session] save failed (${path.basename(file)}): ${e.message}`);
    }
  }
  _read(file) {
    try {
      if (!fs.existsSync(file)) return [];
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.log(`[session] load failed (${path.basename(file)}): ${e.message}`);
      return [];
    }
  }

  savePanes(specs) { this._write(this.panesFile, specs); }
  loadPanes() { return this._read(this.panesFile); }
  saveWires(wires) { this._write(this.wiresFile, wires); }
  loadWires() { return this._read(this.wiresFile); }
}

module.exports = { SessionStore };
