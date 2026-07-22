'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// Phase 4B: best-effort cost tracking. The ONLY real token source for our
// agents is Claude Code's own transcripts (~/.claude/projects/<munged-cwd>/*.jsonl,
// one usage block per assistant message). We scan the transcript dirs that
// match each claude pane's cwd and sum usage recorded after the pane spawned.
// Everything here is an ESTIMATE and is labeled as such in the UI; when a
// transcript can't be found the UI shows '—', never a fake number.
// Codex/aider panes have no counts. All reads are local files.
const PRICES = {
  // USD per million tokens: [input, output, cacheRead, cacheWrite] (approx)
  opus: [15, 75, 1.5, 18.75],
  sonnet: [3, 15, 0.3, 3.75],
  haiku: [1, 5, 0.1, 1.25],
  default: [3, 15, 0.3, 3.75],
};
function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return PRICES.opus;
  if (m.includes('haiku')) return PRICES.haiku;
  if (m.includes('sonnet')) return PRICES.sonnet;
  return PRICES.default;
}
function mungeCwd(cwd) {
  // C:\Users\x\proj → C--Users-x-proj (Claude Code's project-dir naming)
  return String(cwd).replace(/[\\/:.]/g, '-');
}

class CostTracker extends EventEmitter {
  constructor({ pty, guard, runlog, getBudgetCap }) {
    super();
    this.pty = pty;
    this.guard = guard;
    this.runlog = runlog;
    this.getBudgetCap = getBudgetCap || (() => 0);
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
    this.perAgent = {}; // id -> {tokensIn, tokensOut, cacheRead, cacheWrite, usd, files:{path->offsetLines}}
    this.capFired = false;
    this.timer = setInterval(() => this.scan().catch(() => {}), 30000);
  }

  // Fixed, directly-measured costs (e.g. Merge Officer `claude -p` passes,
  // which report exact usage via --output-format json).
  addFixed(label, usd, tokens) {
    this.fixed = this.fixed || { usd: 0, tokens: 0 };
    this.fixed.usd += usd || 0;
    this.fixed.tokens += tokens || 0;
    this.emit('update', this.snapshot());
    this._checkCap();
  }

  _checkCap() {
    const totals = this.totals();
    const cap = Number(this.getBudgetCap()) || 0;
    if (cap > 0 && totals.usd > cap && !this.capFired) {
      this.capFired = true;
      this.guard.pause('budget cap $' + cap + ' reached (est. $' + totals.usd + ')');
      if (this.runlog) this.runlog.add('guard.paused', { data: { reason: 'budget cap $' + cap + ' reached' } });
    }
    if (cap === 0 || totals.usd <= cap) this.capFired = false;
  }

  // A killed agent's per-agent record is dropped to bound memory over a long
  // session, but the money was already spent — fold its totals into `retired`
  // so the budget cap keeps counting it. (Its transcript won't be re-scanned:
  // scan() only iterates LIVE claude panes, and a respawn re-scans from a new
  // createdAt, so no double-count.)
  forget(id) {
    const a = this.perAgent[id];
    if (!a) return;
    if (a.found) {
      this.retired = this.retired || { tokensIn: 0, tokensOut: 0, usd: 0 };
      this.retired.tokensIn += a.tokensIn;
      this.retired.tokensOut += a.tokensOut;
      this.retired.usd += a.usd;
    }
    delete this.perAgent[id];
  }

  totals() {
    let tokens = 0, usd = 0, known = false;
    Object.keys(this.perAgent).forEach((id) => {
      const a = this.perAgent[id];
      if (!a.found) return;
      known = true;
      tokens += a.tokensIn + a.tokensOut;
      usd += a.usd;
    });
    if (this.retired && (this.retired.usd || this.retired.tokensIn || this.retired.tokensOut)) {
      known = true;
      tokens += this.retired.tokensIn + this.retired.tokensOut;
      usd += this.retired.usd;
    }
    if (this.fixed && (this.fixed.usd || this.fixed.tokens)) {
      known = true;
      tokens += this.fixed.tokens;
      usd += this.fixed.usd;
    }
    return { known, tokens, usd: Math.round(usd * 100) / 100 };
  }

  snapshot() {
    const out = { perAgent: {}, totals: this.totals() };
    Object.keys(this.perAgent).forEach((id) => {
      const a = this.perAgent[id];
      out.perAgent[id] = { found: a.found, tokens: a.tokensIn + a.tokensOut, usd: Math.round(a.usd * 100) / 100 };
    });
    return out;
  }

  async scan() {
    const claudePanes = this.pty.list().filter((p) => p.agentType === 'claude');
    if (!claudePanes.length) return;
    for (const pane of claudePanes) {
      const rec = this.perAgent[pane.id] || (this.perAgent[pane.id] = {
        tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usd: 0, found: false, files: {},
      });
      const full = this.pty.get(pane.id);
      const since = (full && full.createdAt) || 0;
      const dir = path.join(this.projectsDir, mungeCwd(pane.cwd));
      let names;
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { continue; }
      for (const name of names) {
        const file = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(file); } catch (_) { continue; }
        if (stat.mtimeMs < since) continue; // finished before this pane existed
        this._scanFile(rec, file, since);
      }
    }
    this.emit('update', this.snapshot());
    this._checkCap();
  }

  _scanFile(rec, file, since) {
    // Incremental by BYTE offset: read only the bytes appended since the last
    // scan, so a multi-MB transcript is never fully re-read every 30s (that was
    // a periodic main-thread stall that grew with session length). The stored
    // offset always sits on a newline boundary, so the partial trailing line is
    // simply re-read next scan once it's complete (no double-count).
    let start = rec.files[file] || 0;
    let fd;
    try {
      const stat = fs.statSync(file);
      if (stat.size < start) start = 0; // file shrank/rotated → re-read from the top
      if (stat.size <= start) { rec.files[file] = start; return; } // nothing new
      const length = stat.size - start;
      const buf = Buffer.allocUnsafe(length);
      fd = fs.openSync(file, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, length, start);
      const chunk = buf.toString('utf8', 0, bytesRead);
      const lastNl = chunk.lastIndexOf('\n');
      if (lastNl === -1) return; // no complete line yet — wait for more (offset unchanged)
      const complete = chunk.slice(0, lastNl); // full lines only; drop the partial tail
      const lines = complete.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i].trim();
        if (!ln) continue;
        let ev;
        try { ev = JSON.parse(ln); } catch (_) { continue; }
        if (ev.type !== 'assistant' || !ev.message || !ev.message.usage) continue;
        const ts = ev.timestamp ? Date.parse(ev.timestamp) : 0;
        if (ts && ts < since) continue;
        const u = ev.message.usage;
        const price = priceFor(ev.message.model);
        const tin = u.input_tokens || 0, tout = u.output_tokens || 0;
        const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
        rec.tokensIn += tin; rec.tokensOut += tout; rec.cacheRead += cr; rec.cacheWrite += cw;
        rec.usd += (tin * price[0] + tout * price[1] + cr * price[2] + cw * price[3]) / 1e6;
        rec.found = true;
      }
      // Advance to just past the last newline (byte length of the complete part + 1).
      rec.files[file] = start + Buffer.byteLength(complete, 'utf8') + 1;
    } catch (_) {
      /* best-effort — ignore read errors */
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { CostTracker, mungeCwd };
