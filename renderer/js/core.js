'use strict';
/* core.js — shared store, the single event hub over window.mesh, and utilities.
 * Everything else hangs off window.AM. Wrapped in an IIFE because the
 * contextBridge globals (window.mesh) are non-configurable and cannot be
 * shadowed by a top-level declaration. This is the ONLY file that calls the
 * mesh.on* subscriptions — other modules subscribe through AM.on(topic, fn). */
(function () {
  const mesh = window.mesh;

  // ---------- utils ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const el = (id) => document.getElementById(id);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]); }
  function dur(since) {
    if (!since) return '';
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  function clock(at) {
    const d = at ? new Date(at) : new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ---------- state ----------
  const state = {
    view: 'chats',
    folders: [],          // [{id,name,repo,isGit,exists,baseBranch,worktrees}]
    selectedFolderId: null,
    panes: [],            // [{id,agentType,role,cwd,folderId}]
    paneMeta: {},         // id -> { branch, worktreePath, launched }
    selectedAgentId: null,
    wires: [],            // [{from,to}]
    snapshot: { tasks: [], locks: [], announcements: [] },
    guard: { total: 0, max: null, paused: false },
    guardReason: null,
    apOn: true,           // autopilot master (renderer-local in 4A)
    apMode: 'supervised', // renderer-local
    startedAt: Date.now(),
    busPort: 0,
    busToken: '',         // per-session bus secret (X-Mesh-Token header for bus POSTs)
    busLog: [],           // [{from,to,message,at,kind}] cap 80
    timeline: [],         // [{at,text,kind}] cap 60
    mergedCount: 0,
    handedOff: {},        // agentId -> true once its Parent has sent it work (FEAT-005)
    cost: { perAgent: {}, totals: { known: false, tokens: 0, usd: 0 } }, // best-effort estimate (4B)
    settings: null,       // app settings mirror ({openMesh, launch, ...}); null until first load
  };

  // ---------- pub/sub ----------
  const subs = {};
  function on(topic, fn) { (subs[topic] = subs[topic] || []).push(fn); return fn; }
  function emit(topic, data) {
    const list = subs[topic];
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { console.error('[' + topic + ']', e && e.message); }
    }
  }

  // ---------- selectors ----------
  function agentsInFolder(folderId) { return state.panes.filter((p) => p.folderId === folderId); }
  function headOf(folderId) {
    const p = state.panes.find((x) => x.folderId === folderId && x.role === 'head');
    return p ? p.id : null;
  }
  function pane(id) { return state.panes.find((p) => p.id === id) || null; }
  function folder(id) { return state.folders.find((f) => f.id === id) || null; }
  function taskFor(agentId) {
    return state.snapshot.tasks.find((t) => t.assignee === agentId && t.status === 'in_progress') || null;
  }
  function locksHeldBy(agentId) { return state.snapshot.locks.filter((l) => l.holder === agentId); }
  function childCountOf(id) { return state.panes.filter((p) => p.parentId === id).length; }
  // Role tier for branding: head > parent (has children) > sub (has a Parent) > worker.
  // A mid-tree pane (parent AND sub) reports 'parent'; callers needing both check parentId too.
  function roleTier(p) {
    if (!p) return 'worker';
    if (p.role === 'head') return 'head';
    if (childCountOf(p.id)) return 'parent';
    if (p.parentId) return 'sub';
    return 'worker';
  }
  const AGENT_BRAND = {
    claude: { cls: 'agent-claude', abbr: 'CL' },
    codex: { cls: 'agent-codex', abbr: 'CX' },
    grok: { cls: 'agent-grok', abbr: 'GK' },
    aider: { cls: 'agent-aider', abbr: 'AD' },
    shell: { cls: 'agent-shell', abbr: 'SH' },
  };
  function agentBrand(type) {
    return AGENT_BRAND[String(type || '').toLowerCase()]
      || { cls: 'agent-generic', abbr: String(type || '?').slice(0, 2).toUpperCase() };
  }
  function lockWaitedBy(agentId) {
    return state.snapshot.locks.find((l) => (l.waiters || []).indexOf(agentId) !== -1) || null;
  }
  // One-line status for sidebar / chat header.
  function microStatus(agentId) {
    const pn = pane(agentId);
    // FEAT-005: a terminal set to "After Parent handoff" waits until its
    // Parent actually sends it work over the parent→child route.
    if (pn && pn.activationPolicy === 'on_parent_handoff' && pn.parentId && !state.handedOff[agentId]) {
      return { text: 'Waiting on parent handoff', wait: true };
    }
    const t = taskFor(agentId);
    if (t && t.activity) {
      const done = (t.steps || []).filter((s) => s.status === 'done').length;
      const tot = (t.steps || []).length;
      return { text: t.activity + (tot ? ' · ' + done + '/' + tot : ''), wait: false };
    }
    const w = lockWaitedBy(agentId);
    if (w) return { text: 'Waiting on ' + w.resource, wait: true };
    const held = locksHeldBy(agentId);
    if (held.length) return { text: 'Holds ' + held[0].resource, wait: false };
    const p = pane(agentId);
    if (p && p.role === 'head') return { text: 'Orchestrating', wait: false };
    if (p && p.exited) return { text: 'Exited', wait: false };
    return { text: 'Ready', wait: false };
  }

  function pushBus(entry) {
    state.busLog.push(entry);
    if (state.busLog.length > 80) state.busLog.shift();
  }
  function pushTimeline(text, kind) {
    state.timeline.push({ at: Date.now(), text: text, kind: kind || '' });
    if (state.timeline.length > 60) state.timeline.shift();
    emit('timeline', state.timeline);
  }

  // ---------- the single mesh.on* wiring (no other module calls these) ----------
  mesh.onPanes((list) => { state.panes = list || []; emit('panes', state.panes); });
  mesh.onWires((w) => { state.wires = w || []; emit('wires', state.wires); });
  mesh.onCoordinatorState((s) => { if (s) state.snapshot = s; emit('snapshot', state.snapshot); });
  mesh.onGuardState((g) => { if (g) state.guard = g; emit('guard', state.guard); });
  mesh.onGuardPaused((r) => { state.guardReason = r; emit('guardPaused', r); });
  mesh.onBusMessage((m) => { emit('busmsg', m); });
  mesh.onAnnounce((a) => { emit('announce', a); });
  mesh.onData((d) => { emit('data', d); });
  mesh.onExit((d) => { emit('exit', d); });
  if (mesh.onFolders) mesh.onFolders((list) => { state.folders = list || []; emit('folders', state.folders); });
  if (mesh.onCostUpdate) mesh.onCostUpdate((s) => { if (s) state.cost = s; emit('cost', state.cost); });
  if (mesh.onSettings) mesh.onSettings((s) => { if (s) { state.settings = s; emit('settings', s); } });
  if (mesh.settingsGet) mesh.settingsGet().then((s) => { if (s) { state.settings = s; emit('settings', s); } }).catch(() => {});
  const openMesh = () => !!(state.settings && state.settings.openMesh);

  window.AM = {
    mesh, state, on, emit,
    $, $$, el, esc, dur, clock,
    agentsInFolder, headOf, pane, folder, taskFor, locksHeldBy, lockWaitedBy, microStatus,
    childCountOf, roleTier, agentBrand,
    pushBus, pushTimeline, openMesh,
  };
})();
