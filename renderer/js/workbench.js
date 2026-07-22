'use strict';
/* workbench.js — AM-FEAT-002: the live AI code workbench ("Code" view).
 *
 * A read-only observability surface over the SELECTED agent's real working
 * directory (repo root for HEAD, its git worktree for workers):
 *   Explorer   = real file tree (sidebar section) with git change markers
 *   Editor     = read-only file content; changed lines from `git diff HEAD`
 *   Follow     = auto-opens the file the agent reports via `mesh at <file>`
 *   Terminal   = ANSI-stripped tail of the agent's real PTY
 *   Changes    = `git status --porcelain` of the agent's cwd
 * Live updates come from a recursive fs watcher (fs:changed events). All
 * content is real; nothing here can write to the filesystem. */
(function () {
  const AM = window.AM, mesh = AM.mesh, el = AM.el, esc = AM.esc;

  const W = {
    agent: null,           // observed agent id
    files: [],             // repo-relative paths
    changes: {},           // path -> git state (M/A/D/??)
    openPath: null,
    lines: [],
    changedLines: {},      // path -> [0-based line indexes]
    follow: true,
    watched: {},           // paneId -> true once fs:watch requested
    lastEditAt: 0,
    binary: false,
    error: null,
    editing: false,        // user is editing the open file (Phase 5.1)
    explorerCollapsed: false,
    loadGen: 0,            // bumped per agent switch — stale async loads bail out
  };
  const inWb = () => AM.state.view === 'workbench';
  const KIND = { ts: 'TS', tsx: 'TSX', js: 'JS', mjs: 'JS', cjs: 'JS', json: '{ }', md: 'MD', html: '<>', css: '#', py: 'PY', rs: 'RS', go: 'GO', txt: 'TXT' };
  function kindOf(p) { const ext = String(p).split('.').pop().toLowerCase(); return KIND[ext] || ext.slice(0, 3).toUpperCase() || '·'; }

  // ---------- data loading ----------
  async function loadAgent(id) {
    const gen = ++W.loadGen; // supersedes any in-flight load for another agent
    W.agent = id;
    W.files = []; W.changes = {}; W.changeStats = {}; W.openPath = null; W.lines = []; W.changedLines = {};
    W.editing = false;
    if (!id || !AM.pane(id)) { renderAll(); return; }
    if (!W.watched[id]) { W.watched[id] = true; mesh.watchFs(id); }
    const [tree, changes] = await Promise.all([mesh.fsTree(id), mesh.fsChanges(id)]);
    if (gen !== W.loadGen) return; // user switched agent while we were reading
    if (tree && tree.files) W.files = tree.files;
    applyChanges(changes);
    // open: agent's reported location > first changed file > first file
    const loc = agentLocation(id);
    const first = (loc && W.files.indexOf(loc) !== -1 && loc) ||
      W.files.find((f) => W.changes[f]) || W.files[0] || null;
    if (first) await openFile(first, false); else renderAll();
  }
  function applyChanges(changes) {
    W.changes = {};
    W.changeStats = {};
    ((changes && changes.rows) || []).forEach((r) => {
      const st = r.state === '??' ? 'A' : r.state[0];
      W.changes[r.path] = st;
      W.changeStats[r.path] = r.stat || '';
      if (W.files.indexOf(r.path) === -1 && st !== 'D') W.files.push(r.path);
    });
  }
  function agentLocation(id) {
    const t = AM.taskFor(id);
    return t && t.location ? String(t.location).split('\\').join('/') : null;
  }
  async function openFile(path, manual) {
    if (manual && W.editing) { AM.toast('May bukas na edit — i-Save o Cancel muna'); return; }
    if (manual && W.follow) setFollow(false);
    const gen = W.loadGen, agent = W.agent;
    W.openPath = path; W.binary = false; W.error = null;
    const [read, diff] = await Promise.all([mesh.fsRead(agent, path), mesh.fsDiff(agent, path)]);
    if (gen !== W.loadGen) return; // agent switched mid-read — drop the stale result
    if (read && read.content != null) W.lines = read.content.split(/\r?\n/);
    else { W.lines = []; W.binary = !!(read && read.binary); W.error = read && read.error; }
    W.changedLines[path] = parseHunks(diff && diff.patch);
    renderAll();
  }
  // Parse unified diff hunks → 0-based NEW-file line indexes that were added/changed.
  function parseHunks(patch) {
    const out = [];
    if (!patch) return out;
    const lines = String(patch).split('\n');
    let newLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(ln);
      if (h) { newLine = parseInt(h[1], 10); continue; }
      if (!newLine) continue;
      if (ln[0] === '+' && ln.slice(0, 3) !== '+++') { out.push(newLine - 1); newLine++; }
      else if (ln[0] === '-' || ln.slice(0, 3) === '---') { /* removed: no new line */ }
      else newLine++;
    }
    return out;
  }

  // ---------- rendering ----------
  let explorerSig = '';
  function renderExplorer() {
    const host = document.getElementById('workspaceExplorer');
    if (!host) return;
    if (!W.agent || !AM.pane(W.agent)) { host.innerHTML = ''; host.hidden = true; explorerSig = ''; return; }
    // Skip identical re-renders — constant rebuilds while agents work would
    // swallow clicks (the "collapse not working" class of bug).
    const sig = [W.agent, W.openPath, W.explorerCollapsed ? 1 : 0, agentLocation(W.agent),
      W.files.join(','), JSON.stringify(W.changes)].join('#');
    if (sig === explorerSig && host.children.length) return;
    explorerSig = sig;
    host.hidden = false;
    const f = AM.folder((AM.pane(W.agent) || {}).folderId);
    const branch = (AM.state.paneMeta[W.agent] && AM.state.paneMeta[W.agent].branch) || (f && f.baseBranch) || '';
    const changedCount = Object.keys(W.changes).length;
    let html = '<div class="explorer-head"><span>Explorer · ' + esc(W.agent) + '</span><span class="explorer-count">' + changedCount + ' changed</span></div>' +
      '<button class="tree-folder" id="explorerFolderRow" type="button" style="width:100%;border:0;background:transparent;cursor:pointer;text-align:left"><span class="quiet">' + (W.explorerCollapsed ? '›' : '⌄') + '</span><span class="folder" aria-hidden="true"></span><span>' + esc(f ? f.name : 'workspace') + '</span><span class="branch mono">' + esc(branch) + '</span></button>' +
      '<div class="file-tree"' + (W.explorerCollapsed ? ' hidden' : '') + '>';
    const loc = agentLocation(W.agent);
    const shown = W.files.slice(0, 80);
    shown.forEach((p) => {
      const name = p.split('/').pop();
      const editing = loc === p;
      html += '<button class="wb-file' + (p === W.openPath ? ' active' : '') + (editing ? ' is-editing' : '') + '" type="button" data-wb-file="' + esc(p) + '">' +
        '<span class="file-kind">' + esc(kindOf(p)) + '</span><span class="file-label" title="' + esc(p) + '">' + esc(name) + '</span>' +
        '<span class="file-state">' + esc(W.changes[p] || '') + '</span></button>';
    });
    if (W.files.length > shown.length) html += '<div class="file-state" style="padding:4px 8px">+' + (W.files.length - shown.length) + ' more…</div>';
    html += '</div>';
    host.innerHTML = html;
    // pointerdown (like editors) — fires before any re-render can swap the node
    const foldRow = host.querySelector('#explorerFolderRow');
    if (foldRow) foldRow.addEventListener('pointerdown', (e) => { e.preventDefault(); W.explorerCollapsed = !W.explorerCollapsed; renderExplorer(); });
    host.querySelectorAll('.wb-file').forEach((b) => {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); AM.setView('workbench'); openFile(b.dataset.wbFile, true); });
    });
  }
  AM.renderExplorer = renderExplorer;

  function renderBar() {
    const has = !!(W.agent && AM.pane(W.agent));
    el('editingAgent').textContent = has ? W.agent : '—';
    const loc = has ? agentLocation(W.agent) : null;
    const live = has && (Date.now() - W.lastEditAt < 4000);
    el('editingVerb').textContent = !has ? 'is idle' : (live ? 'is editing' : (loc ? 'is working' : 'is idle'));
    el('editingPath').textContent = !has ? 'select an agent to observe its workspace' : (loc || W.openPath || 'no file open');
    el('liveBeacon').classList.toggle('running', live);
    const act = el('workbenchActivity');
    act.classList.toggle('running', live);
    act.querySelector('.dot').classList.toggle('live', live);
    el('workbenchActivityText').textContent = live ? 'Live edit' : (has ? 'Watching' : 'Idle');
    const branch = has && AM.state.paneMeta[W.agent] && AM.state.paneMeta[W.agent].branch;
    const bEl = el('wbBranch');
    if (branch) { bEl.textContent = branch; bEl.classList.remove('hidden'); } else bEl.classList.add('hidden');
    el('followEditor').textContent = (W.follow ? 'Following ' : 'Follow ') + (has ? W.agent : 'agent');
    el('followEditor').setAttribute('aria-pressed', String(W.follow));
    // (dockStatus is owned by renderTerminal — it names the scratch shell's folder)
    // edit-mode chrome (Phase 5.1)
    el('wbModeChip').textContent = W.editing ? 'editing' : 'view';
    el('editToggle').textContent = W.editing ? 'Save' : 'Edit';
    el('editToggle').classList.toggle('hidden', !W.openPath || W.binary || !!W.error);
    el('editCancel').classList.toggle('hidden', !W.editing);
  }
  function renderEditor() {
    const code = el('liveCode');
    // edit mode: the textarea IS the surface; the read view stays hidden
    el('editTextarea').classList.toggle('hidden', !W.editing);
    code.parentElement.classList.toggle('hidden', W.editing);
    if (W.editing) return;
    const f = AM.folder(W.agent && AM.pane(W.agent) ? AM.pane(W.agent).folderId : null);
    el('editorRepo').textContent = f ? f.name : '—';
    if (!W.openPath) {
      el('editorFolder').textContent = '—';
      el('editorFileName').textContent = 'no file';
      code.textContent = W.agent ? (W.error || 'No files to show yet.') : 'Select an agent in the sidebar, then open a file from its Explorer.';
      el('editPresence').hidden = true;
      return;
    }
    const parts = W.openPath.split('/');
    el('editorFileName').textContent = parts.pop();
    el('editorFolder').textContent = parts.join('/') || '·';
    if (W.binary) { code.textContent = 'Binary file — not rendered.'; el('editPresence').hidden = true; return; }
    if (W.error) { code.textContent = W.error; el('editPresence').hidden = true; return; }
    const changed = W.changedLines[W.openPath] || [];
    const changedSet = {};
    changed.forEach((i) => { changedSet[i] = 1; });
    const frag = document.createDocumentFragment();
    const loc = agentLocation(W.agent);
    W.lines.slice(0, 2000).forEach((src, i) => {
      const line = document.createElement('span'); line.className = 'code-line';
      if (changedSet[i]) line.classList.add('is-changed');
      const num = document.createElement('span'); num.className = 'line-number'; num.textContent = String(i + 1);
      const text = document.createElement('span'); text.className = 'code-source'; text.textContent = src || ' ';
      line.append(num, text); frag.appendChild(line);
    });
    code.replaceChildren(frag);
    const presence = el('editPresence');
    const editingHere = loc === W.openPath && (Date.now() - W.lastEditAt < 6000);
    presence.hidden = !editingHere;
    if (editingHere) presence.textContent = W.agent + ' · editing here';
  }
  function renderChanges() {
    const list = el('changeList');
    const rows = Object.keys(W.changes);
    if (!rows.length) { list.innerHTML = '<div class="change-row"><span class="change-mark">·</span><span>No uncommitted changes</span><span class="change-stat"></span></div>'; return; }
    list.innerHTML = rows.map((p) =>
      '<div class="change-row"><span class="change-mark">' + esc(W.changes[p]) + '</span><span>' + esc(p) + '</span><span class="change-stat">' + esc(W.changeStats[p] || '') + '</span></div>').join('');
  }
  // The Code-view Terminal is a plain USER shell rooted at the project folder
  // (like VS Code's integrated terminal) — NOT an agent's TUI. One per folder;
  // you type here to run whatever you want.
  let wbTermId = null;
  async function renderTerminal() {
    const folderId = AM.state.selectedFolderId;
    if (!folderId) return;
    const id = 'wbterm-' + folderId;
    if (wbTermId !== id) {
      wbTermId = id;
      if (AM.prepareTerm) AM.prepareTerm(id); // create the xterm before the PTY emits its prompt
      let info;
      try { info = await mesh.wbtermEnsure(folderId); } catch (_) { info = null; }
      if (!info || !info.ok) { wbTermId = null; return; }
      const st = el('dockStatus'); if (st) st.textContent = (info.cwd || '').split(/[\\/]/).pop() + ' · shell';
    }
    if (AM.placeTerm) AM.placeTerm(id, el('dockTermHost'));
  }
  function renderAll() { if (inWb()) { renderBar(); renderEditor(); renderChanges(); renderTerminal(); } renderExplorer(); }
  AM.renderWorkbench = renderAll;

  // ---------- follow ----------
  function setFollow(on) { W.follow = on; renderBar(); }
  el('followEditor').onclick = () => { setFollow(!W.follow); if (W.follow) maybeFollow(); };
  function maybeFollow() {
    if (!W.follow || !W.agent || W.editing) return; // never yank the file away mid-edit
    const loc = agentLocation(W.agent);
    if (loc && loc !== W.openPath && W.files.indexOf(loc) !== -1) openFile(loc, false);
  }

  // ---------- edit mode (Phase 5.1: the editor is now writable) ----------
  function enterEdit() {
    if (!W.openPath || W.binary || W.error) { AM.toast('Walang editable na file na bukas'); return; }
    W.editing = true;
    const ta = el('editTextarea');
    ta.value = W.lines.join('\n');
    renderBar(); renderEditor();
    ta.focus();
  }
  async function saveEdit() {
    const ta = el('editTextarea');
    const gen = W.loadGen, agent = W.agent, path = W.openPath;
    let r;
    try { r = await mesh.fsWrite(agent, path, ta.value); } catch (e) { r = { ok: false, error: e && e.message }; }
    if (!r || !r.ok) { AM.toast('Save failed: ' + ((r && r.error) || 'error')); return; }
    AM.toast('Saved ' + path);
    if (gen !== W.loadGen) return; // agent switched mid-save — don't touch new state
    W.editing = false;
    await openFile(path, false); // fresh read + git-diff line highlights
    const changes = await mesh.fsChanges(agent);
    if (gen !== W.loadGen) return;
    applyChanges(changes);
    renderAll();
  }
  function cancelEdit() {
    W.editing = false;
    renderBar(); renderEditor();
    AM.toast('Edit discarded');
  }
  el('editToggle').onclick = () => { if (W.editing) saveEdit(); else enterEdit(); };
  el('editCancel').onclick = cancelEdit;
  el('editTextarea').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEdit(); }
    else if (e.key === 'Escape') { e.stopPropagation(); cancelEdit(); }
  });

  // ---------- resizable dock (drag the top edge; persists) ----------
  const dock = el('workbenchDock');
  function setDockHeight(h) {
    h = Math.max(120, Math.min(Math.round(window.innerHeight * 0.75), Math.round(h)));
    dock.style.setProperty('--dock-h', h + 'px');
    try { localStorage.setItem('am-dock-h', String(h)); } catch (_) {}
    return h;
  }
  try { const saved = parseInt(localStorage.getItem('am-dock-h'), 10); if (saved) setDockHeight(saved); } catch (_) {}
  let dockDrag = null, dockFitRaf = 0;
  const grip = el('dockResize');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dockDrag = { startY: e.clientY, startH: dock.getBoundingClientRect().height };
    grip.classList.add('dragging');
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dockDrag) return;
    setDockHeight(dockDrag.startH + (dockDrag.startY - e.clientY)); // drag up = taller
    if (!dockFitRaf) dockFitRaf = requestAnimationFrame(() => { dockFitRaf = 0; renderTerminal(); });
  });
  function endDockDrag(e) {
    dockDrag = null;
    grip.classList.remove('dragging');
    try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
    renderTerminal(); // final refit at the new size
  }
  grip.addEventListener('pointerup', endDockDrag);
  grip.addEventListener('pointercancel', endDockDrag); // interrupted drag must not stick
  // quick maximize/restore
  let dockPrevH = 0;
  el('dockMax').onclick = function () {
    const cur = dock.getBoundingClientRect().height;
    const tall = Math.round(window.innerHeight * 0.6);
    if (cur < tall - 20) { dockPrevH = cur; setDockHeight(tall); this.textContent = '⌄'; }
    else { setDockHeight(dockPrevH || 220); this.textContent = '⌃'; }
    renderTerminal();
  };

  // ---------- dock tabs ----------
  document.querySelectorAll('.dock-tab').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.dock-tab').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.dock-pane').forEach((p) => p.classList.toggle('active', p.id === 'dock-' + b.dataset.dock));
      if (b.dataset.dock === 'terminal') renderTerminal(); // refit the live xterm
    };
  });

  // ---------- subscriptions ----------
  AM.on('view', (v) => { if (v === 'workbench') { if (AM.state.selectedAgentId !== W.agent) loadAgent(AM.state.selectedAgentId); else renderAll(); } });
  AM.on('selectAgent', (id) => { if (id !== W.agent) loadAgent(id); });
  AM.on('snapshot', () => { if (inWb()) { renderBar(); maybeFollow(); } renderExplorer(); });
  AM.on('exit', (d) => { if (d.id === W.agent && inWb()) renderBar(); });
  // Drop the fs:watch flag for panes that are gone (re-set harmlessly on respawn).
  AM.on('panes', (list) => {
    Object.keys(W.watched).forEach((id) => { if (!(list || []).some((p) => p.id === id)) delete W.watched[id]; });
  });
  if (mesh.onFsChanged) mesh.onFsChanged(async (d) => {
    if (d.id !== W.agent) return;
    const gen = W.loadGen;
    W.lastEditAt = Date.now();
    const changes = await mesh.fsChanges(d.id);
    if (gen !== W.loadGen) return; // agent switched — this event is for the old one
    applyChanges(changes);
    if (d.files && d.files.indexOf(W.openPath) !== -1 && !W.editing) { // never clobber an open edit
      const [read, diff] = await Promise.all([mesh.fsRead(d.id, W.openPath), mesh.fsDiff(d.id, W.openPath)]);
      if (gen !== W.loadGen) return;
      if (read && read.content != null) W.lines = read.content.split(/\r?\n/);
      W.changedLines[W.openPath] = parseHunks(diff && diff.patch);
    } else if (d.files && d.files.length) {
      const fresh = d.files.filter((p) => W.files.indexOf(p) === -1 && !p.split('/').some((s) => s[0] === '.'));
      if (fresh.length) W.files = W.files.concat(fresh).sort();
    }
    maybeFollow();
    renderAll();
    setTimeout(() => { if (inWb()) { renderBar(); renderEditor(); } }, 4200); // settle the live state
  });
})();
