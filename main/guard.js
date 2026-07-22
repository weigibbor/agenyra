'use strict';
const { EventEmitter } = require('events');

// Guardrails for autonomous agent messaging: a max-exchange cap, loop detection,
// and a global pause/stop. Only AGENT-originated messages are counted or limited;
// human/UI messages (briefings, tasks) are always allowed and never counted.
class Guard extends EventEmitter {
  constructor() {
    super();
    this.maxMessages = null; // null = unlimited
    this.paused = false;
    this.total = 0;
    this.perPane = {};
    this.recent = []; // rolling window of "from>to:message" keys
    this.loopThreshold = 3; // identical key this many times in the window -> loop
    this.window = 8;
  }

  setMax(n) {
    this.maxMessages = n && n > 0 ? n : null;
    if (this.maxMessages === null || this.total < this.maxMessages) this.paused = false;
    this._changed();
  }

  pause(reason) {
    if (!this.paused) {
      this.paused = true;
      this.emit('paused', reason || 'paused');
    }
    this._changed();
  }

  resume() {
    this.paused = false;
    this._changed();
  }

  reset() {
    this.total = 0;
    this.perPane = {};
    this.recent = [];
    this.paused = false;
    this._changed();
  }

  // Decide whether an agent message may be routed. Returns { allow, reason, key }.
  check(from, to, message) {
    if (this.paused) return { allow: false, reason: 'paused' };
    if (this.maxMessages && this.total >= this.maxMessages) {
      this.pause(`max exchanges (${this.maxMessages}) reached`);
      return { allow: false, reason: 'max exchanges reached' };
    }
    const key = `${from}>${to}:${message}`;
    const same = this.recent.filter((k) => k === key).length;
    if (same >= this.loopThreshold - 1) {
      this.pause(`loop detected: ${from} → ${to} repeated`);
      return { allow: false, reason: 'loop detected' };
    }
    return { allow: true, key };
  }

  // Record an allowed message after it is routed.
  record(from, key) {
    this.total++;
    this.perPane[from] = (this.perPane[from] || 0) + 1;
    if (key) {
      this.recent.push(key);
      if (this.recent.length > this.window) this.recent.shift();
    }
    this._changed();
  }

  stats() {
    return { total: this.total, perPane: this.perPane, max: this.maxMessages, paused: this.paused };
  }

  _changed() {
    this.emit('change', this.stats());
  }
}

module.exports = { Guard };
