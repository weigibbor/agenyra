'use strict';
const http = require('http');
const { Router } = require('./router');

const MAX_BODY = 1024 * 1024; // 1 MB — bus messages are short; cap stops OOM floods

// Local-only HTTP bus on 127.0.0.1. The `mesh` CLI inside each pane posts here;
// requests are delegated to the Router (messaging) and Coordinator (tasks,
// locks, announcements, progress). Bound to loopback only — never on the network.
class Bus {
  constructor({ router, coordinator, ptyManager, engine, token }) {
    this.router = router;
    this.coordinator = coordinator;
    this.pty = ptyManager;
    this.engine = engine || null; // Autopilot engine (Phase 4B); optional in tests
    this.token = token || null;   // per-session secret; when null (tests) the gate is skipped
    this.server = null;
    this.port = 0;
  }

  setEngine(engine) {
    this.engine = engine;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      let started = false;
      // A listen failure (e.g. EADDRINUSE) must reject so boot() can surface it,
      // not leave the promise pending forever. Post-listen errors just log —
      // they must never crash the process.
      this.server.on('error', (err) => {
        if (!started) reject(err);
        else console.error('[bus] server error:', (err && err.message) || err);
      });
      this.server.listen(0, '127.0.0.1', () => {
        started = true;
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  _reply(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  // Gate every request. The caller must present the per-session token in a custom
  // header (a custom header forces a CORS preflight that cross-origin web pages
  // can't satisfy, and they can't read the token anyway); the Host must be our
  // loopback address (blocks DNS-rebinding onto the bus); and no browser Origin/
  // cross-site fetch is accepted. Returns null when allowed. Token null = tests.
  _authorize(req) {
    const host = req.headers.host || '';
    if (host !== '127.0.0.1:' + this.port && host !== 'localhost:' + this.port) {
      return { code: 403, error: 'bad host' };
    }
    if (req.headers.origin) return { code: 403, error: 'cross-origin requests are not allowed' };
    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'none' && sfs !== 'same-origin') {
      return { code: 403, error: 'cross-site requests are not allowed' };
    }
    if (this.token && req.headers['x-mesh-token'] !== this.token) {
      return { code: 403, error: 'invalid or missing mesh token' };
    }
    return null;
  }

  _handle(req, res) {
    res.on('error', () => {}); // a client reset mid-response must not throw unhandled
    const denied = this._authorize(req);
    if (denied) return this._reply(res, denied.code, { ok: false, error: denied.error });
    const url = new URL(req.url, 'http://127.0.0.1');
    const c = this.coordinator;

    if (req.method === 'GET') {
      try {
      switch (url.pathname) {
        case '/panes':
          return this._reply(res, 200, { panes: this.pty.list() });
        case '/tasks':
          return this._reply(res, 200, { tasks: c.listTasks() });
        case '/locks':
          return this._reply(res, 200, { locks: c.listLocks() });
        case '/missions':
          return this._reply(res, 200, { missions: this.engine ? this.engine.listMissions() : [] });
        case '/mission': {
          const pane = url.searchParams.get('pane');
          const m = this.engine ? this.engine.missionFor(pane) : null;
          return this._reply(res, 200, m ? { ok: true, mission: { id: m.id, goal: m.goal, status: m.status } } : { ok: false, error: 'no active mission for your folder' });
        }
        case '/state':
          return this._reply(res, 200, c.snapshot());
        default:
          return this._reply(res, 404, { ok: false, error: 'not found' });
      }
      } catch (e) {
        return this._reply(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }

    if (req.method !== 'POST') return this._reply(res, 405, { ok: false, error: 'method not allowed' });

    const ctype = (req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) {
      // text/plain would be a CORS "simple request" (no preflight) — reject it so
      // only genuine JSON callers (the mesh CLI) get through.
      return this._reply(res, 415, { ok: false, error: 'content-type must be application/json' });
    }

    // Cap the body BEFORE buffering — an unbounded POST could OOM the main
    // process. Collect Buffers and decode once (a UTF-8 char split across TCP
    // chunks would corrupt a naive string concat).
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('error', () => { aborted = true; });
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        this._reply(res, 413, { ok: false, error: 'request body too large' });
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString('utf8');
      let p = {};
      try {
        p = body ? JSON.parse(body) : {};
      } catch (_) {
        return this._reply(res, 400, { ok: false, error: 'bad json' });
      }
      const from = p.from || 'unknown';
      // Hardening: bus callers are PANES (the mesh CLI injects MESH_PANE).
      // Reject impersonation of trusted system senders ('human'/'autopilot' —
      // those originate in-process, never over the bus) and unknown senders,
      // so no agent can bypass wires or the guard by forging `from`.
      if (Router.SYSTEM_SENDERS.has(from)) {
        return this._reply(res, 403, { ok: false, error: `sender "${from}" is reserved` });
      }
      if (!this.pty.has(from)) {
        return this._reply(res, 403, { ok: false, error: `unknown pane "${from}"` });
      }
      try {
        if (this.engine) this.engine.noteBusActivity(from); // stall detector heartbeat
        switch (url.pathname) {
          case '/send':
            return this._reply(res, 200, this.router.route(from, p.to, p.message, p.submit !== false));
          case '/task/add':
            return this._reply(res, 200, { ok: true, task: c.addTask(p.title, p.steps || []) });
          case '/task/claim': {
            const t = c.claimTask(from);
            return this._reply(res, 200, { ok: !!t, task: t });
          }
          case '/task/done':
            return this._reply(res, 200, c.doneTask(from, p.id));
          case '/task/review':
            return this._reply(res, 200, c.reviewTask(from, p.id));
          case '/step/add':
            return this._reply(res, 200, c.addStep(from, p.label));
          case '/step/start':
            return this._reply(res, 200, c.startStep(from, p.label));
          case '/step/done':
            return this._reply(res, 200, c.doneStep(from, p.label));
          case '/status':
            return this._reply(res, 200, c.setActivity(from, p.activity));
          case '/at':
            return this._reply(res, 200, c.setLocation(from, p.location));
          case '/lock/acquire':
            return this._reply(res, 200, c.acquireLock(from, p.resource));
          case '/lock/release':
            return this._reply(res, 200, c.releaseLock(from, p.resource));
          case '/announce':
            return this._reply(res, 200, c.announce(from, p.message));
          case '/mission/done': {
            if (!this.engine) return this._reply(res, 200, { ok: false, error: 'autopilot engine not running' });
            // missionDone is async on the happy path — resolve it before replying,
            // else the caller gets a stringified pending Promise ("{}") and never
            // sees resolution errors.
            return Promise.resolve(this.engine.missionDone(from, p.summary))
              .then((out) => this._reply(res, 200, out))
              .catch((e) => this._reply(res, 500, { ok: false, error: String((e && e.message) || e) }));
          }
          case '/mission/blocked':
            return this._reply(res, 200, this.engine
              ? this.engine.missionBlocked(from, p.reason)
              : { ok: false, error: 'autopilot engine not running' });
          default:
            return this._reply(res, 404, { ok: false, error: `unknown ${url.pathname}` });
        }
      } catch (e) {
        return this._reply(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { Bus };
