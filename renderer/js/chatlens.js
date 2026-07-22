'use strict';
/* chatlens.js — the chat "lens" over each agent's real PTY.
 *
 * Each agent has a message thread synthesized from the mesh bus + coordinator
 * snapshots, plus a live xterm behind a Chat/Raw toggle (same PTY, two lenses).
 * The chat NEVER invents terminal content it can't parse: agent-to-agent talk
 * comes from bus messages, discrete events from snapshot diffs, and the raw
 * terminal is one toggle away. */
(function () {
  const AM = window.AM, mesh = AM.mesh, el = AM.el, $$ = AM.$$, esc = AM.esc, clock = AM.clock;

  // agentId -> { items, unread, lastPtyAt, term, fit, mount, info, _lastIn, bytes }
  const chats = {};
  // Phase 5: readiness detector — a CLI TUI is "ready" once it has drawn a
  // meaningful amount of output and gone quiet. Gated sends (briefs, restore
  // briefs) queue here instead of firing on blind delays.
  const readyQueue = {}; // agentId -> [cb]
  const READY_BYTES = 2000, READY_QUIET_MS = 800, READY_TIMEOUT_MS = 12000;
  function isReady(id) {
    const c = chats[id];
    if (!c) return false;
    if ((c.bytes || 0) > READY_BYTES && Date.now() - c.lastPtyAt > READY_QUIET_MS) return true;
    return !!(c.launchAt && Date.now() - c.launchAt > READY_TIMEOUT_MS); // fallback: send anyway
  }
  function whenReady(id, cb) {
    if (isReady(id)) { cb(); return; }
    (readyQueue[id] = readyQueue[id] || []).push(cb);
  }
  setInterval(() => {
    Object.keys(readyQueue).forEach((id) => {
      if (!readyQueue[id].length) return;
      if (!AM.pane(id)) { readyQueue[id] = []; return; } // died while waiting
      if (isReady(id)) {
        const cbs = readyQueue[id]; readyQueue[id] = [];
        cbs.forEach((cb) => { try { cb(); } catch (_) {} });
      }
    });
  }, 500);
  let prevSnap = { tasks: [], locks: [] };
  let snapPrimed = false; // first snapshot primes silently (no replayed history)
  let goalMode = false;

  // Launch commands + effort config come from settings (Phase 5); fallbacks here.
  const LAUNCH = { claude: 'claude --dangerously-skip-permissions', codex: 'codex --dangerously-bypass-approvals-and-sandbox', grok: 'grok --always-approve', aider: 'aider --yes-always' };
  let appSettings = { launch: LAUNCH, effortFlags: { claude: '--effort {level}', grok: '--effort {level}', codex: '-c model_reasoning_effort="{level}"', aider: '' }, defaultEffort: 'high' };
  const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  function applySettings(s) {
    if (!s) return;
    appSettings = s;
    if (s.launch) Object.assign(LAUNCH, s.launch);
    trackOpenMesh(!!s.openMesh);
  }
  if (mesh.settingsGet) {
    mesh.settingsGet().then(applySettings).catch(() => {});
    if (mesh.onSettings) mesh.onSettings(applySettings);
  }
  // Build a launch command with the app-controlled reasoning effort injected via
  // the per-preset flag template (real launch param, not a guess). Returns the
  // effort we actually set (authoritative for the header) or null if unmanaged.
  function launchCmd(preset, explicitEffort) {
    let cmd = LAUNCH[preset];
    if (!cmd) return { cmd: null, effort: null };
    const effort = explicitEffort || appSettings.defaultEffort || '';
    const tpl = (appSettings.effortFlags || {})[preset] || '';
    const managed = !!(effort && tpl && EFFORT_LEVELS.indexOf(effort) !== -1);
    const flagName = tpl.split(/\s|=/)[0];
    if (managed && flagName && cmd.indexOf(flagName) < 0) cmd = cmd + ' ' + tpl.replace('{level}', effort);
    return { cmd, effort: managed ? effort : null };
  }
  const TERM_THEME = {
    background: '#000000', foreground: '#f5f5f7', cursor: '#f5f5f7',
    selectionBackground: 'rgba(255,255,255,0.20)',
    black: '#1a1a1d', red: '#ff453a', green: '#30d158', yellow: '#ffd60a',
    blue: '#64d2ff', magenta: '#bf5af2', cyan: '#64d2ff', white: '#f5f5f7',
    brightBlack: '#6e6e73', brightRed: '#ff6961', brightGreen: '#5ee07d', brightYellow: '#ffe14d',
    brightBlue: '#8fe0ff', brightMagenta: '#d08bff', brightCyan: '#8fe0ff', brightWhite: '#ffffff',
  };

  const sel = () => AM.state.selectedAgentId;
  const inChats = () => AM.state.view === 'chats';
  const rawMode = () => el('view-chats').classList.contains('raw-mode');
  const isHeadId = (id) => { const p = AM.pane(id); return !!(p && p.role === 'head'); };
  const shorten = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

  let retiredMax = 0; // highest t<n> ever disposed — ids never regress within a session
  function nextId() {
    let max = retiredMax;
    AM.state.panes.forEach((p) => { const m = /^t(\d+)$/.exec(p.id); if (m) max = Math.max(max, +m[1]); });
    Object.keys(chats).forEach((id) => { const m = /^t(\d+)$/.exec(id); if (m) max = Math.max(max, +m[1]); });
    return 't' + (max + 1);
  }

  // Explicit close = the agent is gone for good (spec deleted, not respawnable):
  // free its xterm buffer, DOM mount, and chat store — otherwise a long session
  // that spawns/closes many agents grows memory without bound. Exited-but-not-
  // closed agents keep their store so the Respawn banner + history still work.
  // Just-closed ids: a `panes` emit already in flight can still list a pane the
  // backend hasn't dropped yet — without this marker the panes handler would
  // rebuild a fresh Terminal for the agent we just disposed (an instant leak).
  const closing = {}; // id -> ts
  function disposeChat(id) {
    const c = chats[id]; if (!c) return;
    const m = /^t(\d+)$/.exec(id); if (m) retiredMax = Math.max(retiredMax, +m[1]);
    try { if (c.term) c.term.dispose(); } catch (_) {}
    try { if (c.mount) c.mount.remove(); } catch (_) {}
    delete chats[id];
    delete briefed[id];
    delete restoreHandled[id];
    delete agentInfo[id];
    if (AM.state.paneMeta) delete AM.state.paneMeta[id];
    if (AM.state.handedOff) delete AM.state.handedOff[id];
    closing[id] = Date.now();
    if (sel() === id) { AM.state.selectedAgentId = null; renderChat(); }
  }
  AM.disposeChat = disposeChat;

  // ---------- xterm (Raw lens) ----------
  function ensureStore(id) {
    if (!chats[id]) chats[id] = { items: [], unread: 0, lastPtyAt: 0, bytes: 0, launchAt: 0, term: null, fit: null, mount: null, info: null, _lastIn: null };
    return chats[id];
  }
  function ensureTerm(id) {
    const c = ensureStore(id);
    if (c.term) return c.term;
    const mount = document.createElement('div'); mount.className = 'rawmount'; mount.style.display = 'none';
    el('rawHost').appendChild(mount);
    const term = new Terminal({
      theme: TERM_THEME, fontSize: 12, fontFamily: 'SFMono-Regular,Consolas,Menlo,monospace',
      cursorBlink: true, scrollback: 2000, allowProposedApi: false,
    });
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
    term.open(mount);
    term.onData((d) => mesh.input(id, d));
    c.term = term; c.fit = fit; c.mount = mount;
    return term;
  }
  function fitTerm(id) {
    const c = chats[id]; if (!c || !c.fit || !c.term) return;
    try { c.fit.fit(); mesh.resize(id, c.term.cols, c.term.rows); } catch (e) {}
  }
  // One xterm per agent, ONE instance that moves between homes (Chats→Raw and
  // the Code view's Terminal dock). Placing it re-parents the mount + refits.
  function placeTerm(id, host) {
    const c = ensureStore(id);
    ensureTerm(id);
    host.appendChild(c.mount);
    c.mount.style.display = 'block';
    requestAnimationFrame(() => { fitTerm(id); try { c.term.refresh(0, c.term.rows - 1); } catch (_) {} });
  }
  AM.placeTerm = placeTerm;
  // Create the xterm+store for an id up front (used by the Code-view scratch
  // terminal so no shell output is dropped before its PTY is mounted).
  AM.prepareTerm = (id) => ensureTerm(id);
  function mountVisible(id) {
    const rawHost = el('rawHost');
    Object.keys(chats).forEach((k) => {
      const m = chats[k].mount;
      if (m && m.parentElement === rawHost && k !== id) m.style.display = 'none';
    });
    if (chats[id] && chats[id].mount) placeTerm(id, rawHost);
  }

  // ---------- spawn ----------
  async function spawnAgent(folderId, preset) {
    folderId = folderId || AM.state.selectedFolderId;
    if (!folderId) { AM.toast('Add a folder first'); return; }
    const id = nextId();
    // AM-FEAT-005: every new terminal starts independent — Normal role (no
    // auto-HEAD), no Parent, no wires. Promote via the Mesh right-click menu.
    const role = 'worker';
    const c = ensureStore(id);
    c.info = { agentType: preset, role: role };
    ensureTerm(id);
    const built = launchCmd(preset); // app-set effort (authoritative) if the preset has a flag template
    let res;
    try {
      res = await mesh.createPty(id, { agentType: preset, role: role, folderId: folderId, effort: built.effort, cols: 80, rows: 24 });
    } catch (e) { AM.toast('Spawn failed: ' + (e && e.message)); return; }
    AM.state.paneMeta[id] = {
      branch: res && res.worktree ? res.worktree.branch : null,
      worktreePath: res && res.worktree ? res.worktree.path : null,
    };
    AM.state.panes = await mesh.listPanes();
    AM.emit('panes', AM.state.panes);
    AM.selectAgent(id);
    if (AM.meshFocus) AM.meshFocus(id);  // mark for the spawn animation…
    AM.setView('mesh');                  // …then land in the Mesh view so you can wire it in
    const open = openMeshOn === true;
    AM.pushTimeline('Spawned ' + id + ' · ' + preset + (open ? ' (open mesh)' : ' (independent)'), 'spawn');

    const launch = built.cmd;
    if (launch) {
      addEvent(id, id + ' launching ' + preset + (built.effort ? ' · effort ' + built.effort : '') + ' (autonomous mode)');
      c.launchAt = Date.now();
      setTimeout(() => mesh.route('human', id, launch, true), 700);
      // Open mesh: every pane is reachable the moment it exists, so brief it as
      // soon as its TUI is ready. Strict mode keeps the "connect to activate"
      // flow — the brief fires on the FIRST wire instead.
      if (open) connectBrief(id);
    }
    AM.toast(open ? 'Spawned ' + id + ' · open mesh — briefing on ready' : 'Spawned ' + id + ' · independent — wire it in Mesh');
  }
  AM.spawnAgent = spawnAgent;

  // AM-FEAT-005: routes are strictly directed. SEND = outgoing wires only;
  // RECEIVE = incoming wires only. The reverse path is a separate wire.
  function sendTargets(id) {
    return (AM.state.wires || []).filter((w) => w.from === id).map((w) => w.to).filter((x) => AM.pane(x));
  }
  function receiveSources(id) {
    return (AM.state.wires || []).filter((w) => w.to === id).map((w) => w.from).filter((x) => AM.pane(x));
  }
  // Open mesh: everyone in the same folder is a peer (pty.list already omits
  // utility scratch shells, so AM.state.panes only ever holds real agents).
  function meshPeers(id) {
    const p = AM.pane(id); if (!p) return [];
    return (AM.state.panes || []).filter((q) => q.id !== id && q.folderId === p.folderId).map((q) => q.id);
  }

  function briefingFor(id) {
    const p = AM.pane(id); const c = chats[id];
    const role = p ? p.role : (c && c.info ? c.info.role : 'worker');
    const open = openMeshOn === true;
    const outs = open ? meshPeers(id) : sendTargets(id);
    const ins = open ? outs.slice() : receiveSources(id);
    // report-to preference: a wired HEAD you can send to > your Parent (if wired) > first outgoing
    const outHead = outs.find((x) => { const q = AM.pane(x); return q && q.role === 'head'; });
    const reportTo = outHead || (p && p.parentId && outs.indexOf(p.parentId) !== -1 ? p.parentId : outs[0]) || null;
    const branch = AM.state.paneMeta[id] && AM.state.paneMeta[id].branch;
    const roleLine = role === 'head'
      ? 'You are a HEAD (orchestrator) in this Agenyra project.'
      : 'You are a worker terminal in this Agenyra project.';
    const branchNote = branch
      ? ' You are in an ISOLATED git worktree on branch "' + branch + '". Do all edits here, then commit: git add -A && git commit -m "<msg>". A HEAD reviews and merges your branch — do NOT merge yourself.'
      : '';
    const roleDuty = role === 'head'
      ? 'As HEAD: plan the work, split it into tasks, delegate to the terminals you can SEND to via `mesh send`, and integrate by reviewing and merging their branches. You alone merge final code.'
      : 'Do one task at a time, then report back with: mesh send ' + (reportTo || '<peer>') + ' "<status>".' + branchNote;
    const routesLine = open
      ? 'Open mesh is ON: you can SEND to and RECEIVE from ALL terminals in this project: ' +
        (outs.join(', ') || '(no peers yet — more may join)') + '.'
      : 'Routes are DIRECTED. You can SEND to: ' + (outs.join(', ') || '(nobody yet)') +
        '. You RECEIVE from: ' + (ins.join(', ') || '(nobody yet)') + '. Only send to terminals you can SEND to.';
    return [
      '[AGENT MESH BRIEFING] You are agent "' + id + '". ' + roleLine,
      routesLine,
      'Talk to other agents by running these shell commands (they reach the mesh bus):',
      '  mesh send <pane> "message"     e.g. mesh send ' + (reportTo || outs[0] || 't1') + ' "done with X"',
      '  mesh announce "message"        broadcast a heads-up to everyone',
      '  mesh task claim | done <id>    pull work from the shared board',
      '  mesh step start|done "label" · mesh status "..." · mesh at "file"',
      '  mesh lock acquire|release <resource>   for shared things (ports, test env)',
      roleDuty,
      'When a message arrives in this terminal, act on it, then reply via mesh. Reply now with a short "ready" to confirm you understand.',
    ].join('\n');
  }
  function briefPane(id) { if (AM.pane(id)) { briefed[id] = true; mesh.route('human', id, briefingFor(id), true); } }
  AM.briefPane = briefPane;

  // ---------- connect-to-activate: brief agents when first wired into the mesh ----------
  const briefed = {};   // agentId -> true once it has the full protocol brief
  let prevWires = [];
  let wiresPrimed = false;
  function wkey(w) { return w.from + '>' + w.to; }
  function connectBrief(id) {
    if (!AM.pane(id) || briefed[id]) return;
    briefed[id] = true;
    // Gated on TUI readiness (Phase 5) — no more racing a booting CLI.
    whenReady(id, () => { if (AM.pane(id)) mesh.route('human', id, briefingFor(id), true); });
  }
  // Directional peer updates (FEAT-005): the source learns it can SEND, the
  // target learns it will RECEIVE — never the reverse.
  function peerUpdateSend(id, target) {
    if (!AM.pane(id) || !AM.pane(target)) return;
    mesh.route('human', id, '[MESH] You can now SEND to ' + target + ' — mesh send ' + target + ' "..."', true);
  }
  function peerUpdateReceive(id, source) {
    if (!AM.pane(id) || !AM.pane(source)) return;
    mesh.route('human', id, '[MESH] You can now RECEIVE from ' + source + '.', true);
  }
  // ---------- open mesh: brief without wires ----------
  // null until the first settings load so boot never reads as a "flip".
  let openMeshOn = null;
  function trackOpenMesh(on) {
    const prev = openMeshOn;
    openMeshOn = on;
    if (prev === null || prev === on) return;
    (AM.state.panes || []).forEach((p) => {
      if (on) {
        if (!briefed[p.id]) { connectBrief(p.id); return; }
        mesh.route('human', p.id, '[MESH] Open mesh ON — you can SEND to and RECEIVE from ALL terminals: ' +
          (meshPeers(p.id).join(', ') || '(no peers yet)') + '.', true);
      } else if (briefed[p.id]) {
        mesh.route('human', p.id, '[MESH] Open mesh OFF — strict routes restored. You can SEND to: ' +
          (sendTargets(p.id).join(', ') || '(nobody)') + '. You RECEIVE from: ' +
          (receiveSources(p.id).join(', ') || '(nobody)') + '.', true);
      }
    });
  }
  AM.on('wires', (wires) => {
    wires = wires || [];
    // First wires event (boot/reload) primes the baseline without re-briefing:
    // agents already wired were briefed in a prior session.
    if (!wiresPrimed) {
      wiresPrimed = true;
      prevWires = wires.slice();
      wires.forEach((w) => { briefed[w.from] = true; briefed[w.to] = true; });
      return;
    }
    const prev = {}; prevWires.forEach((w) => { prev[wkey(w)] = 1; });
    const fresh = wires.filter((w) => !prev[wkey(w)]);
    prevWires = wires.slice();
    fresh.forEach((w) => {
      const aNew = !briefed[w.from], bNew = !briefed[w.to];
      connectBrief(w.from); // briefs if new — the brief already lists directed routes
      connectBrief(w.to);
      // While open mesh is on, directional "you can now SEND/RECEIVE" lines are
      // noise (everyone can already talk) — wires only matter for strict mode.
      if (openMeshOn === true) return;
      if (!aNew) peerUpdateSend(w.from, w.to);   // already briefed → directional update only
      if (!bNew) peerUpdateReceive(w.to, w.from);
    });
  });

  // Open mesh peer roster: when a NEW pane joins a folder while open mesh is
  // on, tell the already-briefed peers their reachable set grew. First panes
  // event only primes (reload/boot must not re-announce the whole mesh).
  const knownPanes = {};
  let panesPrimed = false;
  AM.on('panes', (list) => {
    list = list || [];
    if (!panesPrimed) {
      panesPrimed = true;
      list.forEach((p) => { knownPanes[p.id] = 1; });
      return;
    }
    const joined = list.filter((p) => !knownPanes[p.id]);
    Object.keys(knownPanes).forEach((id) => { if (!list.some((p) => p.id === id)) delete knownPanes[id]; });
    joined.forEach((p) => {
      knownPanes[p.id] = 1;
      if (openMeshOn !== true) return;
      list.forEach((q) => {
        if (q.id === p.id || q.folderId !== p.folderId || !briefed[q.id]) return;
        mesh.route('human', q.id, '[MESH] ' + p.id + ' joined the open mesh — you can now reach: ' +
          (meshPeers(q.id).join(', ') || p.id) + '.', true);
      });
    });
  });

  // ---------- item store + append ----------
  function push(id, item) {
    const c = ensureStore(id);
    c.items.push(item);
    if (c.items.length > 400) c.items.shift();
    const visible = id === sel() && inChats();
    if (visible) {
      appendNode(c, item);
      pinOrNudge();
    } else if (item.kind !== 'evt' || item.count !== false) {
      c.unread++;
      AM.renderSidebar();
    }
  }
  function addEvent(id, text) { push(id, { kind: 'evt', text: text, ts: Date.now() }); }

  function nodeFor(c, item) {
    const frag = document.createDocumentFragment();
    if (item.kind === 'in') {
      const who = item.from === 'human' ? 'you' : item.from;
      if (c._lastIn !== item.from) {
        const r = document.createElement('div'); r.className = 'route';
        r.textContent = item.from === 'human' ? 'From you' : 'Routed from ' + item.from;
        frag.appendChild(r);
      }
      c._lastIn = item.from;
      const m = document.createElement('div'); m.className = 'message out';
      m.innerHTML = '<div class="msg-body"><div class="meta">' + esc(who) +
        (item.meta ? ' · ' + esc(item.meta) : '') + ' · ' + clock(item.ts) +
        '</div><div class="bubble"></div></div>';
      m.querySelector('.bubble').textContent = item.text;
      frag.appendChild(m);
    } else if (item.kind === 'reply') {
      c._lastIn = null;
      const src = item.from, isHead = (() => { const p = AM.pane(src); return !!(p && p.role === 'head'); })();
      const art = document.createElement('article');
      art.className = 'routed-reply';
      art.dataset.source = src;
      art.innerHTML =
        '<div class="route-anchor" aria-hidden="true"><span class="route-rail"></span><span class="route-origin">' + esc(src.toUpperCase()) + '</span><span class="route-end"></span></div>' +
        '<div class="reply-card">' +
        '<div class="reply-meta"><span class="source-badge"><span>' + esc(src.toUpperCase()) + '</span> ' + esc(src) + ' replied</span>' +
        '<span class="route-trail"><b>' + esc(src) + '</b><i>→</i><b>' + esc(item.to || '') + '</b></span>' +
        '<span class="arrival">arrived ' + clock(item.ts) + '</span></div>' +
        '<p></p>' +
        '<div class="reply-context"><span>' + (item.context ? 'Working on <strong>' + esc(item.context) + '</strong> · ' : '') +
        (isHead ? 'From <strong>' + esc(src) + ' orchestration</strong> · ' : '') + '1 hop</span>' +
        '<span class="reply-actions"><button class="reply-action" type="button" data-reply-action="copy">Copy</button>' +
        '<button class="reply-action" type="button" data-reply-action="reply">Reply</button></span></div></div>';
      art.querySelector('p').textContent = item.text;
      frag.appendChild(art);
    } else if (item.kind === 'out') {
      c._lastIn = null;
      const m = document.createElement('div'); m.className = 'message';
      m.innerHTML = '<div class="msg-avatar">' + esc((item.from || '').toUpperCase()) + '</div>' +
        '<div class="msg-body"><div class="meta">' + esc(item.from) + ' · ' + (item.meta ? esc(item.meta) + ' · ' : '') + clock(item.ts) +
        '</div><div class="bubble"></div></div>';
      m.querySelector('.bubble').textContent = item.text;
      frag.appendChild(m);
    } else {
      c._lastIn = null;
      const e = document.createElement('div'); e.className = 'event';
      e.textContent = item.text;
      frag.appendChild(e);
    }
    return frag;
  }
  const THREAD_DOM_CAP = 500; // items[] is capped at 400; keep the live DOM near it
  function appendNode(c, item) {
    const thread = el('thread');
    if (typingEl && typingEl.parentNode === thread) thread.removeChild(typingEl);
    thread.appendChild(nodeFor(c, item));
    // The item store is capped, but the thread DOM was not — over a long live
    // chat it grew to thousands of nodes, and each append reflowed all of them.
    // Evict from the top (oldest) so the visible window stays bounded.
    while (thread.childElementCount > THREAD_DOM_CAP && thread.firstElementChild && thread.firstElementChild !== typingEl) {
      thread.removeChild(thread.firstElementChild);
    }
    if (typingEl) thread.appendChild(typingEl);
  }

  // ---------- scroll pinning ----------
  function atBottom() { const s = el('threadScroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 48; }
  function toBottom() { const s = el('threadScroll'); s.scrollTop = s.scrollHeight; el('newMsg').classList.remove('show'); }
  function pinOrNudge() { if (atBottom()) toBottom(); else el('newMsg').classList.add('show'); }
  el('newMsg').onclick = toBottom;
  el('threadScroll').addEventListener('scroll', () => { if (atBottom()) el('newMsg').classList.remove('show'); });

  // ---------- typing indicator ----------
  let typingEl = null, typingTimer = null;
  // Coalesce the typing/scroll work: fast agent output arrives 60+ chunks/sec and
  // showTyping() forces layout (atBottom/toBottom). Batch it to ONE call per
  // animation frame instead of one per chunk.
  let typingRaf = 0;
  function scheduleTyping() {
    if (typingRaf) return;
    typingRaf = requestAnimationFrame(() => { typingRaf = 0; showTyping(true); });
  }
  function showTyping(on) {
    const thread = el('thread');
    if (on) {
      if (!typingEl) {
        typingEl = document.createElement('div'); typingEl.className = 'message';
        typingEl.innerHTML = '<div class="msg-avatar">' + esc((sel() || '').toUpperCase()) +
          '</div><div class="msg-body"><div class="bubble typing"><i></i><i></i><i></i></div></div>';
      }
      thread.appendChild(typingEl);
      if (atBottom()) toBottom();
      clearTimeout(typingTimer); typingTimer = setTimeout(() => showTyping(false), 2600);
    } else if (typingEl) {
      if (typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
      typingEl = null; clearTimeout(typingTimer);
    }
  }

  // ---------- header + progress + banner ----------
  // Real-time model/effort/context, parsed from the agent's RENDERED terminal
  // footer (not hardcoded, not the byte stream — the byte stream never contains
  // the redrawn footer). Generic across CLIs: any TUI that prints a known model
  // family in its status area is picked up (Claude, GPT/Codex, Grok, DeepSeek,
  // Kimi, GLM, Gemini, Llama, Qwen, Mistral…). Falls back to the preset name.
  const MODEL_RE = /\b(Opus|Sonnet|Haiku|Claude|GPT[\w.\- ]*|o[1345][\w.\-]*|Codex|Grok[\w.\-]*|DeepSeek[\w.\-]*|Kimi[\w.\-]*|GLM[\w.\-]*|Gemini[\w.\-]*|Llama[\w.\-]*|Qwen[\w.\-]*|Mistral[\w.\-]*)\b/i;
  const EFFORT_SEG = /^(none|minimal|low|medium|high|xhigh|max)(?:\s*(?:effort|reasoning|thinking))?$/i;
  function parseFooter(id) {
    const c = chats[id];
    if (!c || !c.term || !c.term.buffer) return null;
    const term = c.term, buf = term.buffer.active;
    const bottom = (buf.baseY || 0) + term.rows;
    // Only the bottom rows are the status/footer region — keeps chat text that
    // happens to mention a model name from being mistaken for the status line.
    for (let y = bottom - 1; y >= Math.max(0, bottom - 12); y--) {
      const line = buf.getLine(y);
      if (!line) continue;
      // Strip box-drawing/block borders first — grok/codex embed the model line
      // inside a rounded box (e.g. "╰── Grok 4.5 (high) · always-approve ─╯").
      const text = line.translateToString(true).replace(/[─-▟]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!text) continue;
      const mm = MODEL_RE.exec(text);
      if (!mm) continue;
      const hasCtx = /(\d+%\s*(?:ctx|context)|\d[\d,.]*\s*(?:k|tokens|tok)\b)/i.test(text);
      if (!(/[·•|]/.test(text) || hasCtx || mm.index <= 2)) continue;
      const parts = text.split(/[·•|]/).map((s) => s.trim()).filter(Boolean);
      const seg = parts.find((s) => MODEL_RE.test(s)) || text;
      // Extract from the model keyword forward (drops any leading border noise).
      const km = MODEL_RE.exec(seg);
      let model = (km ? seg.slice(km.index) : seg).replace(/\s{2,}/g, ' ').trim();
      // Effort next to the model: parens "(high)" (grok) or a trailing token
      // "gpt-5.6-sol max" (codex). Claude's "(1M context)" is NOT an effort word.
      let inlineEffort = '';
      const pe = model.match(/\((none|minimal|low|medium|high|xhigh|max)\)/i);
      if (pe) { inlineEffort = pe[1].toLowerCase(); model = model.replace(pe[0], '').replace(/\s{2,}/g, ' ').trim(); }
      const te = model.match(/\s+(none|minimal|low|medium|high|xhigh|max)$/i);
      if (te) { inlineEffort = inlineEffort || te[1].toLowerCase(); model = model.slice(0, te.index).trim(); }
      model = model.slice(0, 34);
      const ctxM = text.match(/(\d+%)\s*(?:ctx|context)/i) || text.match(/(\d[\d,.]*\s*(?:k|tokens|tok))\b/i);
      const ctx = ctxM ? ctxM[1].replace(/\s+/g, '') : '';
      const effSeg = parts.find((s) => EFFORT_SEG.test(s)) ||
        (text.match(/(?:effort|reasoning|thinking)[:\s]+(none|minimal|low|medium|high|xhigh|max)/i) || [])[1];
      const effort = (effSeg ? String(effSeg).replace(/\s*(effort|reasoning|thinking)/i, '').trim().toLowerCase() : '') || inlineEffort;
      if (model) return { model, ctx, effort };
    }
    return null;
  }

  // Shared per-agent runtime info (model/effort/ctx) so the Mesh nodes and the
  // sidebar can show it too, not just the chat header. Effort prefers the
  // app-set launch value (authoritative); model/ctx come from the live footer.
  const agentInfo = {};
  AM.agentInfo = (id) => agentInfo[id] || null;
  function shortModel(m) { return String(m || '').replace(/\s*\(1M context\)/i, ' 1M').replace(/\s{2,}/g, ' ').trim(); }
  function refreshAgentInfo() {
    let changed = false;
    (AM.state.panes || []).forEach((p) => {
      if (!p || p.agentType === 'shell') return;
      const c = chats[p.id];
      // parseFooter reads ~12 terminal buffer lines (allocating a full-width
      // string each) — skip it when no new bytes arrived since the last parse,
      // since the footer can't have changed. Big idle-CPU win with many agents.
      let parsed = null;
      if (c && c.term && c._footerBytes !== c.bytes) { parsed = parseFooter(p.id); c._footerBytes = c.bytes; }
      const prev = agentInfo[p.id] || {};
      const model = (parsed && parsed.model) ? shortModel(parsed.model) : (prev.model || '');
      const ctx = (parsed && parsed.ctx) ? parsed.ctx : (prev.ctx || '');
      // Footer-reported effort is the truth (what the CLI actually runs); the
      // app-set launch value is the fallback for CLIs that don't print it (claude).
      const effort = (parsed && parsed.effort) || p.effort || prev.effort || '';
      if (model !== prev.model || ctx !== prev.ctx || effort !== prev.effort) {
        agentInfo[p.id] = { model, ctx, effort };
        changed = true;
      }
      // Coax a footer draw for any AI agent whose model is still unknown.
      if (!model && c && c.term && !c._nudgedInfo) { c._nudgedInfo = 1; nudgeRedraw(p.id); }
    });
    if (changed) AM.emit('agentinfo', agentInfo);
    return changed;
  }
  AM.refreshAgentInfo = refreshAgentInfo;

  // A hidden terminal (Chat view) sits at its spawn size and only redraws its
  // footer when the agent acts. Sizing it to real dimensions makes the CLI
  // redraw immediately, so the model/ctx footer lands in the buffer without the
  // user ever opening Raw. No visible effect — the terminal is hidden here.
  function nudgeRedraw(id) {
    const c = chats[id];
    if (!c || !c.term || !AM.pane(id)) return;
    const host = el('thread');
    const cols = Math.max(80, Math.min(220, Math.floor(((host.clientWidth || 900) - 24) / 7.2)));
    const rows = Math.max(24, Math.min(60, Math.floor(((host.clientHeight || 700) - 20) / 18)));
    try {
      if (c.term.cols !== cols || c.term.rows !== rows) { c.term.resize(cols, rows); mesh.resize(id, cols, rows); }
      else { c.term.resize(cols, rows - 1); mesh.resize(id, cols, rows - 1); setTimeout(() => { try { c.term.resize(cols, rows); mesh.resize(id, cols, rows); } catch (_) {} }, 60); }
    } catch (_) {}
  }

  function updateHeader() {
    const id = sel(); const p = AM.pane(id); const c = chats[id];
    if (!id || !c) return;
    const info = p || (c.info || {});
    const micro = AM.microStatus(id);
    el('chatName').textContent = id;
    // Live model info; keep the last good parse to avoid flicker during redraws.
    const mi = parseFooter(id);
    if (mi && mi.model) c.modelInfo = mi;
    const shown = c.modelInfo;
    setChip('chatModel', (shown && shown.model) ? shown.model : (info.agentType || ''));
    // Role/tier chip + agent-type accent (branding). setChip owns the hidden
    // state of chatModel, so only swap agent-* classes — never the class list.
    const tier = p ? AM.roleTier(p) : (info.role === 'head' ? 'head' : 'worker');
    const brand = AM.agentBrand(info.agentType);
    const roleEl = el('chatRole');
    const roleText = tier === 'head' ? '♛ HEAD'
      : tier === 'parent' ? 'Parent · ' + AM.childCountOf(id)
      : tier === 'sub' ? 'Sub of ' + ((p && p.parentId) || '') : '';
    roleEl.className = 'chip role-chip ' + tier + (roleText ? '' : ' hidden');
    roleEl.textContent = roleText;
    const modelEl = el('chatModel');
    modelEl.classList.remove('agent-claude', 'agent-codex', 'agent-grok', 'agent-aider', 'agent-shell', 'agent-generic');
    modelEl.classList.add('agent-chip', brand.cls);
    // Effort: the CLI's own footer value is the truth; app-set launch value is
    // the fallback for CLIs that don't print effort (e.g. Claude).
    const effort = (shown && shown.effort) || (info.effort) || '';
    const effChip = el('chatEffort');
    setChip('chatEffort', effort ? effort + ' effort' : '');
    effChip.classList.toggle('clickable', !!AM.pane(id));
    effChip.title = 'Reasoning effort' + (info.effort ? ' (set by Agenyra)' : (effort ? ' (from the agent)' : '')) + ' — click to change';
    setChip('chatCtx', (shown && shown.ctx) ? shown.ctx + ' ctx' : '');
    const branch = AM.state.paneMeta[id] && AM.state.paneMeta[id].branch;
    setChip('chatBranch', branch || (info.role === 'head' ? 'repo root' : ''));
    const held = AM.locksHeldBy(id)[0];
    const lockEl = el('chatLock');
    if (held) { lockEl.textContent = held.resource + ' locked'; lockEl.classList.remove('hidden'); }
    else lockEl.classList.add('hidden');
    const dot = el('chatDot');
    dot.className = 'dot ' + (p ? (micro.wait ? 'wait' : 'live') : '');
    el('goalToggle').classList.toggle('hidden', !(info.role === 'head'));
  }
  function setChip(id, text) { const e = el(id); if (text) { e.textContent = text; e.classList.remove('hidden'); } else e.classList.add('hidden'); }

  // Click the effort chip → pick a level. For Claude we change it LIVE via the
  // /effort slash command; other CLIs get the value recorded (relaunch applies).
  el('chatEffort').addEventListener('click', () => {
    const id = sel(); const p = AM.pane(id);
    if (!p || !AM.miniMenu) return;
    const cur = p.effort || (chats[id] && chats[id].modelInfo && chats[id].modelInfo.effort) || '';
    AM.miniMenu(el('chatEffort'), EFFORT_LEVELS.map((l) => ({ label: l + (l === cur ? ' ✓' : ''), value: l })), (lvl) => {
      if (!lvl) return;
      mesh.setEffort(id, lvl); // authoritative record (persists, survives restart)
      if (p.agentType === 'claude') { mesh.route('human', id, '/effort ' + lvl, true); AM.toast('Effort → ' + lvl + ' (applied live)'); }
      else AM.toast('Effort set to ' + lvl + ' — relaunch ' + id + ' to apply');
      const c = chats[id]; if (c && c.info) c.info.effort = lvl;
      setTimeout(updateHeader, 200);
    });
  });

  function updateProgress() {
    const id = sel(); const box = el('progress');
    if (!id || !inChats()) { box.classList.add('hidden'); return; }
    const t = AM.taskFor(id);
    if (!t) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const done = (t.steps || []).filter((s) => s.status === 'done').length;
    const tot = (t.steps || []).length;
    el('progStep').textContent = t.activity || t.title || 'Working';
    el('progCount').textContent = tot ? done + '/' + tot : '';
    el('progBar').style.width = tot ? Math.round((done / tot) * 100) + '%' : '30%';
    const fileEl = el('progFile');
    if (t.location) { fileEl.textContent = t.location; fileEl.classList.remove('hidden'); } else fileEl.classList.add('hidden');
  }

  function renderBanner() {
    const thread = el('thread');
    thread.querySelectorAll('.banner').forEach((b) => b.remove());
    const id = sel();
    // Phase 5: dead agent → offer a one-click respawn (same id, same worktree).
    if (id && chats[id] && !AM.pane(id)) {
      const b = document.createElement('div'); b.className = 'banner';
      b.innerHTML = '<span>' + esc(id) + ' has exited — its branch and wires are intact</span><span class="push"></span>' +
        '<button class="button small" id="bannerRespawn" type="button">Respawn</button>';
      thread.insertBefore(b, thread.firstChild);
      const rb = el('bannerRespawn'); if (rb) rb.onclick = () => AM.respawnAgent(id);
    }
    if (AM.state.guard.paused) {
      const b = document.createElement('div'); b.className = 'banner';
      b.innerHTML = '<span>⏸ Paused — ' + esc(AM.state.guardReason || 'guard') + '</span><span class="push"></span>' +
        '<button class="button small" id="bannerResume" type="button">Resume</button>';
      thread.insertBefore(b, thread.firstChild);
      const r = el('bannerResume'); if (r) r.onclick = () => { mesh.resumeGuard(); AM.toast('Resumed'); };
    }
  }

  // ---------- full render ----------
  function renderChat() {
    const id = sel(); const thread = el('thread');
    const c = id ? chats[id] : null;
    const has = !!c;
    el('composer').classList.toggle('hidden', !has);
    ['chatMode', 'chatActions'].forEach((x) => el(x).classList.toggle('hidden', !has));
    if (!has) {
      el('chatName').textContent = AM.state.folders.length ? 'No agent selected' : 'Welcome';
      ['chatModel', 'chatEffort', 'chatCtx', 'chatBranch', 'chatLock'].forEach((x) => el(x).classList.add('hidden'));
      el('chatDot').className = 'dot';
      el('progress').classList.add('hidden');
      thread.innerHTML = AM.state.folders.length
        ? '<div class="empty"><div class="glyph">▤</div><h3>No agent selected</h3><p>Spawn an agent from the sidebar, then talk to it here. The chat is a live terminal underneath — flip to Raw anytime.</p></div>'
        : '<div class="empty"><div class="glyph">◫</div><h3>Add a project to begin</h3><p>Use ＋ Folder in the sidebar to add a git repo, then spawn a HEAD agent to orchestrate the work.</p></div>';
      return;
    }
    c.unread = 0; c._lastIn = null;
    thread.innerHTML = '';
    renderBanner();
    typingEl = null;
    c.items.slice(-400).forEach((item) => thread.appendChild(nodeFor(c, item)));
    // Coax a fresh footer draw so the model/ctx chips populate without opening Raw.
    if (!c.modelInfo && AM.pane(id)) setTimeout(() => { nudgeRedraw(id); setTimeout(() => updateHeader(), 900); }, 120);
    updateHeader(); updateProgress();
    setChatMode('chat');
    requestAnimationFrame(toBottom);
    AM.renderSidebar();
  }
  AM.renderChat = renderChat;
  AM.unreadFor = (id) => (chats[id] ? chats[id].unread : 0);

  // ---------- Chat / Raw toggle ----------
  function setChatMode(mode) {
    $$('#chatMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    const raw = mode === 'raw';
    el('view-chats').classList.toggle('raw-mode', raw);
    if (raw && sel()) { ensureTerm(sel()); mountVisible(sel()); requestAnimationFrame(() => fitTerm(sel())); }
  }
  $$('#chatMode button').forEach((b) => { b.onclick = () => setChatMode(b.dataset.mode); });

  // ---------- composer + goal ----------
  // ---------- pasted-image attachments (screenshots) ----------
  let attachments = []; // [{path, name}]
  function renderAttachTray() {
    const tray = el('attachTray');
    tray.hidden = !attachments.length;
    tray.innerHTML = attachments.map((a, i) =>
      '<span class="attach-chip"><span class="attach-ico">🖼</span>' + esc(a.name) +
      '<button type="button" class="attach-x" data-ai="' + i + '" aria-label="Remove">×</button></span>').join('');
    tray.querySelectorAll('.attach-x').forEach((b) => {
      b.onclick = () => { attachments.splice(+b.dataset.ai, 1); renderAttachTray(); };
    });
  }
  function hasImage(e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    return [...items].some((it) => it.type && it.type.indexOf('image') === 0);
  }
  // Save the first clipboard image and return {path,name}. Reads the file
  // synchronously (before any await) so clipboardData stays valid. Shared by the
  // chat composer and the raw terminal.
  function imageFromPaste(e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const imgItem = [...items].find((it) => it.type && it.type.indexOf('image') === 0);
    const file = imgItem && imgItem.getAsFile();
    if (!file) return Promise.resolve(null);
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = async () => {
        try { const r = await mesh.attachSave(fr.result); resolve(r && r.ok ? r : null); }
        catch (_) { resolve(null); }
      };
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(file);
    });
  }
  async function handlePaste(e) {
    if (!hasImage(e)) return; // let text paste normally
    e.preventDefault();
    const r = await imageFromPaste(e);
    if (r) { attachments.push({ path: r.path, name: r.name }); renderAttachTray(); AM.toast('Screenshot attached — it will be sent with your message'); }
    else AM.toast('Attach failed');
  }
  el('messageInput').addEventListener('paste', handlePaste);

  // Raw terminal: a terminal can't render an image, so save the pasted screenshot
  // and TYPE its file path into the PTY (the agent CLI reads the path — same idea
  // as chat mode appending the path). Capture phase so we intercept before xterm's
  // own text-paste handler; text pastes fall through to xterm untouched.
  async function handleRawPaste(e) {
    if (!rawMode()) return;
    const id = sel(); if (!id) return;
    if (!hasImage(e)) return;
    e.preventDefault(); e.stopPropagation();
    const r = await imageFromPaste(e);
    if (r) { mesh.input(id, r.path.replace(/\\/g, '/') + ' '); AM.toast('Screenshot saved — path typed into the terminal'); }
    else AM.toast('Attach failed');
  }
  el('rawHost').addEventListener('paste', handleRawPaste, true);

  el('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = sel(); if (!id) return;
    const input = el('messageInput'); let text = input.value.trim();
    if (!text && !attachments.length) { input.focus(); return; }
    // Attach image paths so the agent (Claude reads image paths) can open them.
    // Forward slashes survive terminal input cleanly on Windows and Claude Code
    // resolves them fine (backslashes get visually mangled in the TUI).
    if (attachments.length) {
      const refs = attachments.map((a) => a.path.replace(/\\/g, '/')).join(' ');
      text = text ? text + '\n\n[images] ' + refs : 'Please look at this image: ' + refs;
      attachments = []; renderAttachTray();
    }
    const isGoal = goalMode && isHeadId(id);
    // The "plan → delegate → HEAD merges" duty already lives in the brief, so the
    // goal is sent lightly tagged (chat shows the clean goal via cleanGoal()).
    if (isGoal) text = '[GOAL] ' + text;
    input.value = '';
    // Safety net: an unwired/unbriefed HEAD won't know the mesh protocol — brief it first.
    let delay = 0;
    if (isGoal && !briefed[id]) { connectBrief(id); delay = 1400; }
    const send = async () => {
      let r;
      try { r = await mesh.route('human', id, text, true); } catch (_) { r = { ok: false, error: 'route failed' }; }
      if (r && r.ok === false) AM.toast(r.error || 'Message blocked');
    };
    if (delay) setTimeout(send, delay); else send();
  });
  function setGoalMode(on) {
    goalMode = on;
    el('composer').classList.toggle('goal', on);
    el('messageInput').placeholder = on ? 'Describe the goal for HEAD…' : 'Message ' + (sel() || 'agent');
  }
  AM.setGoalMode = setGoalMode;
  el('goalToggle').onclick = () => setGoalMode(!goalMode);

  // ---------- agent actions menu ----------
  el('chatActions').onclick = function () {
    const id = sel(); if (!id) return;
    AM.miniMenu(this, [
      { label: 'Brief agent (mesh protocol)', value: 'brief' },
      { label: 'Set as HEAD', value: 'head' },
      { label: 'Open Raw terminal', value: 'raw' },
      '-',
      { label: 'Close agent', value: 'close' },
    ], (v) => {
      if (v === 'brief') { briefPane(id); AM.toast('Briefing ' + id); }
      else if (v === 'head') { mesh.setRole(id, 'head'); AM.toast(id + ' is now HEAD'); }
      else if (v === 'raw') setChatMode('raw');
      else if (v === 'close') { mesh.kill(id); disposeChat(id); AM.toast('Closing ' + id); }
    });
  };

  // ---------- snapshot differ ----------
  function indexBy(arr, key) { const m = {}; (arr || []).forEach((x) => { m[x[key]] = x; }); return m; }
  function snapKey(next) {
    return { tasks: (next.tasks || []).map((t) => ({ id: t.id, status: t.status, assignee: t.assignee })), locks: (next.locks || []).map((l) => ({ resource: l.resource, holder: l.holder })) };
  }
  function diffSnapshot(next) {
    // First real snapshot: capture as baseline without replaying pre-existing
    // tasks/locks as fresh events (e.g. after a renderer reload).
    if (!snapPrimed) { snapPrimed = true; prevSnap = snapKey(next); return; }
    const nl = next.locks || [], pl = indexBy(prevSnap.locks, 'resource');
    nl.forEach((l) => { const p = pl[l.resource]; if (l.holder && (!p || p.holder !== l.holder)) emitEvent(l.holder, l.holder + ' acquired ' + l.resource); });
    (prevSnap.locks || []).forEach((l) => { const n = indexBy(nl, 'resource')[l.resource]; if (l.holder && (!n || n.holder !== l.holder)) emitEvent(l.holder, l.holder + ' released ' + l.resource); });
    const pt = indexBy(prevSnap.tasks, 'id');
    (next.tasks || []).forEach((t) => {
      const p = pt[t.id];
      if ((!p || p.status !== t.status) && t.assignee) {
        if (t.status === 'in_progress') emitEvent(t.assignee, t.assignee + ' claimed ' + t.title);
        else if (t.status === 'review') emitEvent(t.assignee, t.assignee + ' sent ' + t.title + ' for review');
        else if (t.status === 'done') emitEvent(t.assignee, t.title + ' finished');
      }
    });
    prevSnap = snapKey(next);
  }
  function emitEvent(agent, text) {
    if (chats[agent]) addEvent(agent, text);
    AM.pushTimeline(text, 'mesh');
  }

  // ---------- store subscriptions ----------
  // Curate the chat lens: orchestration plumbing (launch cmd, mesh briefing,
  // peer updates, goal wrapper) still reaches the PTY (Raw shows it) but the
  // chat renders it as a clean event or a stripped bubble — never raw protocol.
  // Read LAUNCH live — settings load async and can rewrite it after this
  // module runs, so a snapshot taken at load time would miss customized
  // launch commands (they'd render as chat bubbles instead of events).
  const launchValues = () => Object.keys(LAUNCH).map((k) => LAUNCH[k]);
  const SYSTEM_SENDERS = { human: 1, autopilot: 1 };
  function classify(from, text) {
    if (!SYSTEM_SENDERS[from]) return 'chat'; // agent speech is always real conversation
    const t = String(text || '').trim();
    // Launch commands (now carry an appended --effort flag) match by prefix.
    if (launchValues().some((v) => t === v || t.indexOf(v + ' ') === 0)) return 'launch';
    if (/^(claude|codex|grok|aider)(\.exe)?\b/.test(t) && /--(effort|dangerously|yes|always-approve)|model_reasoning_effort/.test(t)) return 'launch';
    if (/^\/effort\b/.test(t)) return 'control'; // slash-command tweak; curated, no bubble
    if (t.indexOf('[AGENT MESH BRIEFING]') === 0) return 'brief';
    if (t.indexOf('[MESH]') === 0) return 'peer';
    if (t.indexOf('[GOAL]') === 0) return 'goal';
    return 'chat';
  }
  function cleanGoal(text) {
    let g = String(text || '').replace(/^\[GOAL\]\s*/, '');
    const cut = g.indexOf('\n\n');
    if (cut !== -1) g = g.slice(0, cut);
    return g.trim();
  }

  AM.on('busmsg', (m) => {
    const from = m.from, to = m.to, at = m.at || Date.now();
    const kind = classify(from, m.message);
    AM.pushBus({ from: from, to: to, message: m.message, at: at, kind: from === 'human' ? 'human' : (isHeadId(from) ? 'head' : 'agent') });
    AM.emit('buslog');
    // Auto-create stores for live panes (e.g. after a renderer reload) so no
    // message for a known agent is ever dropped.
    if (to && !chats[to] && AM.pane(to)) ensureStore(to);
    if (from && !chats[from] && AM.pane(from)) ensureStore(from);
    // FEAT-005: a Parent's first message over parent→child is the handoff —
    // it clears the "Waiting on parent handoff" state.
    const tp = to && AM.pane(to);
    if (tp && tp.activationPolicy === 'on_parent_handoff' && tp.parentId === from && !AM.state.handedOff[to]) {
      AM.state.handedOff[to] = true;
      addEvent(to, 'Parent handoff received from ' + from);
      AM.pushTimeline(from + ' handed off to ' + to, 'mesh');
      AM.emit('panes', AM.state.panes); // refresh sidebar + mesh node status everywhere
    }
    if (to && chats[to]) {
      if (kind === 'launch') { /* covered by the "launching" event; no bubble */ }
      else if (kind === 'control') addEvent(to, 'effort → ' + String(m.message).replace(/^\/effort\s*/, '').trim());
      else if (kind === 'brief') addEvent(to, to + ' connected to the mesh · briefed');
      else if (kind === 'peer') addEvent(to, String(m.message).replace(/^\[MESH\]\s*/, ''));
      else if (kind === 'goal') push(to, { kind: 'in', from: from, text: cleanGoal(m.message), ts: at, meta: 'goal' });
      else if (from !== 'human' && AM.pane(from)) {
        // AM-FEAT-001: a connected terminal replied — render a durable routed-reply card
        const srcTask = AM.taskFor(from);
        push(to, { kind: 'reply', from: from, to: to, text: m.message, ts: at, context: srcTask ? srcTask.title : null });
      } else push(to, { kind: 'in', from: from, text: m.message, ts: at });
    }
    if (from && chats[from] && from !== to) push(from, { kind: 'out', from: from, text: m.message, ts: at });
    if (isHeadId(from) && to && kind === 'chat') AM.pushTimeline(from + ' → ' + to + ': ' + shorten(m.message, 56), 'route');
  });
  AM.on('announce', (a) => {
    AM.pushBus({ from: a.from, to: 'all', message: a.message, at: a.at, kind: 'announce' });
    AM.emit('buslog');
    if (chats[a.from]) push(a.from, { kind: 'out', from: a.from, text: a.message, ts: a.at, meta: 'announced' });
  });
  AM.on('data', (d) => {
    const c = chats[d.id]; if (!c) return;
    ensureTerm(d.id).write(d.data);
    c.lastPtyAt = Date.now();
    c.bytes = (c.bytes || 0) + d.data.length;
    if (d.id === sel() && inChats() && !rawMode()) scheduleTyping();
  });
  AM.on('exit', (d) => {
    const c = chats[d.id]; if (!c) return;
    if (c.info) c.info.exited = true;
    addEvent(d.id, d.id + ' exited (code ' + d.exitCode + ')');
    AM.pushTimeline(d.id + ' exited', 'exit');
    if (d.id === sel() && inChats()) { updateHeader(); renderBanner(); }
  });
  AM.on('snapshot', (s) => { diffSnapshot(s); if (inChats()) { updateProgress(); updateHeader(); } });
  // Live model/effort/context refresh for ALL agents (footer changes without any
  // app event — ctx ticks down, /model or /effort switches). Feeds the chat
  // header, the Mesh nodes, and the sidebar from one shared store.
  setInterval(() => {
    if (document.hidden) return; // window backgrounded — nothing on screen to update
    if (!AM.state.panes || !AM.state.panes.length) return;
    const changed = refreshAgentInfo();
    if (changed && inChats() && !rawMode()) updateHeader();
  }, 1500);
  AM.on('guard', () => { if (inChats()) renderBanner(); });
  AM.on('guardPaused', (r) => { AM.toast('Paused: ' + r); if (inChats()) renderBanner(); });
  AM.on('selectAgent', () => { setGoalMode(false); renderChat(); });
  AM.on('view', (v) => { if (v === 'chats') renderChat(); });
  // After a reload the panes still live in the main process — rebuild a chat
  // store + terminal for each so chats, Raw, and replies keep working.
  // Session-restored panes (Phase 5) additionally get their CLI relaunched:
  // Claude with --continue (resumes the prior conversation when one exists,
  // silently starts fresh otherwise — spike-verified), then a re-brief once
  // the TUI is ready. The brief is harmless on a resumed session and required
  // on a fresh one, so it is sent unconditionally.
  const restoreHandled = {};
  function restoreLaunch(p) {
    if (!p.restored || restoreHandled[p.id]) return;
    restoreHandled[p.id] = true;
    const c = ensureStore(p.id);
    ensureTerm(p.id);
    if (p.agentType === 'shell') return;
    // --continue only when main verified a transcript exists for this cwd —
    // interactive claude exits otherwise and the relaunch lands in the shell.
    // Derive the --continue variant from the (settings-overridable) launch
    // command so customized flags survive a session restore too.
    const claudeContinue = /^claude\b/.test(LAUNCH.claude || '')
      ? LAUNCH.claude.replace(/^claude\b/, 'claude --continue')
      : 'claude --continue --dangerously-skip-permissions';
    let cmd = p.agentType === 'claude'
      ? (p.canContinue ? claudeContinue : LAUNCH.claude)
      : LAUNCH[p.agentType];
    if (!cmd) return;
    // Re-inject the agent's saved effort so restored sessions keep their level.
    const tpl = (appSettings.effortFlags || {})[p.agentType] || '';
    const flagName = tpl.split(/\s|=/)[0];
    if (p.effort && tpl && flagName && cmd.indexOf(flagName) < 0) cmd = cmd + ' ' + tpl.replace('{level}', p.effort);
    addEvent(p.id, p.id + ' restored — relaunching ' + p.agentType);
    c.launchAt = Date.now();
    if (mesh.markLaunched) mesh.markLaunched(p.id); // reloads must never re-type the launch
    setTimeout(() => mesh.route('human', p.id, cmd, true), 700);
    whenReady(p.id, () => { if (AM.pane(p.id)) { briefed[p.id] = true; mesh.route('human', p.id, briefingFor(p.id), true); } });
  }
  // Reclaim memory from agents that have exited. Freeing the xterm (a 4000-line
  // scrollback buffer + canvas) is the big win; items[] stays so the Respawn
  // banner + chat history keep working, and the term is recreated on respawn or
  // when raw mode is opened. The Code-view scratch shell (never in state.panes,
  // so wasAgent is never set) is left untouched.
  const RETAINED_MAX = 24; // exited chats kept before the oldest are dropped whole
  function reclaimExitedChats(present) {
    const retired = [];
    Object.keys(chats).forEach((id) => {
      const c = chats[id];
      if (present[id] || !c.wasAgent) return; // live agent, or the scratch shell
      if (id !== sel() && c.term) {
        try { c.term.dispose(); } catch (_) {}
        try { if (c.mount) c.mount.remove(); } catch (_) {}
        c.term = c.fit = c.mount = null;
      }
      if (!c.retiredAt) c.retiredAt = Date.now();
      retired.push(id);
    });
    // Bound retained dead chats over a marathon session — drop the oldest whole
    // (store + history), never the one the user is currently looking at.
    if (retired.length > RETAINED_MAX) {
      retired
        .filter((id) => id !== sel())
        .sort((a, b) => (chats[a].retiredAt || 0) - (chats[b].retiredAt || 0))
        .slice(0, retired.length - RETAINED_MAX)
        .forEach((id) => disposeChat(id));
    }
  }
  AM.on('panes', (list) => {
    const present = {};
    (list || []).forEach((p) => {
      // Don't resurrect a just-closed agent from a stale in-flight panes list.
      if (closing[p.id]) return;
      present[p.id] = 1;
      const c = ensureStore(p.id);
      c.wasAgent = true;   // a real agent (distinguishes it from the scratch shell)
      c.retiredAt = 0;     // back among the living
      ensureTerm(p.id);    // idempotent; recreates a term freed while it was exited
      restoreLaunch(p);
    });
    // Clear close markers once the backend confirms the pane is gone (or after a
    // safety timeout), so an id can never be permanently suppressed.
    Object.keys(closing).forEach((id) => {
      if (!(list || []).some((p) => p.id === id) || Date.now() - closing[id] > 5000) delete closing[id];
    });
    reclaimExitedChats(present);
    // The exit event can beat the panes update — once the list settles, show
    // the Respawn banner if the selected agent is gone.
    if (sel() && chats[sel()] && !AM.pane(sel()) && inChats()) { renderBanner(); updateHeader(); }
  });

  // Phase 5: bring a dead agent back with the same identity + worktree.
  AM.respawnAgent = async (id) => {
    let r;
    try { r = await mesh.respawn(id); } catch (e) { r = { ok: false, error: e && e.message }; }
    if (r && r.ok) {
      delete restoreHandled[id]; // let the restore pass relaunch its CLI
      if (chats[id] && chats[id].info) chats[id].info.exited = false;
      AM.state.panes = await mesh.listPanes();
      AM.emit('panes', AM.state.panes);
      AM.toast('Respawned ' + id);
      renderChat();
    } else {
      AM.toast((r && r.error) || 'Respawn failed');
    }
    return r;
  };

  // Routed-reply card actions (AM-FEAT-001): Copy → clipboard; Reply → jump to
  // the source agent's chat with the composer focused.
  el('thread').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-reply-action]');
    if (!btn) return;
    const art = btn.closest('.routed-reply');
    const src = art && art.dataset.source;
    if (btn.dataset.replyAction === 'copy') {
      const text = art.querySelector('.reply-card p');
      if (text && navigator.clipboard) {
        navigator.clipboard.writeText(text.textContent).then(() => AM.toast('Copied'), () => AM.toast('Copy failed'));
      }
    } else if (btn.dataset.replyAction === 'reply' && src && AM.pane(src)) {
      AM.selectAgent(src);
      requestAnimationFrame(() => el('messageInput').focus());
    }
  });

  // keep raw terminal sized to its pane
  const ro = new ResizeObserver(() => { if (rawMode() && sel()) fitTerm(sel()); });
  ro.observe(el('threadScroll'));
})();
