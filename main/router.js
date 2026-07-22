'use strict';
const { EventEmitter } = require('events');

// Routes messages between panes, but only along wires the user has drawn.
// AM-FEAT-005: every wire is a single directed permission — `a->b` lets a
// SEND to b and b RECEIVE from a; the reverse path is a separate wire. HEAD
// is a role, not a routing bypass. Only the human/UI is exempt. This strict
// wire-enforcement is the first guardrail against a rogue agent injecting
// into another.
class Router extends EventEmitter {
  constructor(ptyManager, guard) {
    super();
    this.pty = ptyManager;
    this.guard = guard || null;
    this.wires = new Set(); // "from->to"
    // Open mesh: every pane may send/receive within its own folder without
    // wires (persisted app setting; main.js applies it). Wires still work as
    // an explicit superset (e.g. cross-folder) and take over when this is off.
    this.openMesh = false;
  }

  addWire(from, to) {
    if (!from || !to || from === to) return false;
    this.wires.add(`${from}->${to}`);
    this.emit('wires', this.listWires());
    return true;
  }

  removeWire(from, to) {
    const ok = this.wires.delete(`${from}->${to}`);
    if (ok) this.emit('wires', this.listWires());
    return ok;
  }

  // Drop every wire touching a pane. Pane ids are small reused integers
  // (t1, t2, …) — if a killed pane's wires lingered, a later agent assigned
  // the same id would silently inherit its send/receive permissions.
  removeWiresFor(id) {
    let changed = false;
    for (const w of [...this.wires]) {
      const [from, to] = w.split('->');
      if (from === id || to === id) { this.wires.delete(w); changed = true; }
    }
    if (changed) this.emit('wires', this.listWires());
    return changed;
  }

  listWires() {
    return [...this.wires].map((w) => {
      const [from, to] = w.split('->');
      return { from, to };
    });
  }

  // Seed persisted wires on boot (session restore) — one event at the end.
  loadWires(list) {
    (list || []).forEach((w) => {
      if (w && w.from && w.to && w.from !== w.to) this.wires.add(`${w.from}->${w.to}`);
    });
    this.emit('wires', this.listWires());
  }

  canRoute(from, to) {
    if (Router.SYSTEM_SENDERS.has(from)) return true; // UI ('human') + engine ('autopilot')
    if (this.openMesh && this._openMeshAllows(from, to)) return true;
    return this.wires.has(`${from}->${to}`); // exact direction only
  }

  // Open mesh is folder-scoped and agent-only: both panes must exist, share a
  // folder, and neither may be a utility pane (wbterm scratch shells must never
  // receive agent traffic). Anything else still needs an explicit wire.
  _openMeshAllows(from, to) {
    const a = this.pty.get(from), b = this.pty.get(to);
    return !!(a && b && !a.utility && !b.utility && a.folderId && a.folderId === b.folderId);
  }

  route(from, to, message, submit = true) {
    if (!this.pty.has(to)) return { ok: false, error: `no pane "${to}"` };
    if (!this.canRoute(from, to)) return { ok: false, error: `not wired: ${from} -> ${to}` };
    // Guardrails apply to agent-originated traffic only (system senders exempt).
    const system = Router.SYSTEM_SENDERS.has(from);
    let guardKey = null;
    if (!system && this.guard) {
      const g = this.guard.check(from, to, message);
      if (!g.allow) return { ok: false, error: g.reason, guard: true };
      guardKey = g.key;
    }
    // Type the text, then submit with a SEPARATE Enter a moment later. Interactive
    // TUIs (e.g. Claude Code) often absorb a trailing CR that arrives in the same
    // chunk as the text — a distinct Enter keystroke reliably submits the message.
    this.pty.write(to, message);
    if (submit) setTimeout(() => this.pty.write(to, '\r'), 120);
    if (!system && this.guard) this.guard.record(from, guardKey);
    this.emit('message', { from, to, message, at: Date.now() });
    return { ok: true };
  }
}

// Trusted non-pane senders: the UI and the Autopilot engine. Nothing coming
// through the bus may claim these identities (enforced in bus.js).
Router.SYSTEM_SENDERS = new Set(['human', 'autopilot']);

module.exports = { Router };
