'use strict';
/* shell.js — the application frame: top bar, sidebar (folders + agents),
 * status bar, command palette, view switching, theme, panel toggles, and the
 * frameless-window controls. Data-driven; content-heavy views fill themselves
 * in via their own modules and the hooks exposed on AM. */
(function () {
  const AM = window.AM, mesh = AM.mesh, el = AM.el, $$ = AM.$$, esc = AM.esc;
  const body = document.body;

  function mobile() { return matchMedia('(max-width:760px)').matches; }
  function compact() { return matchMedia('(max-width:1120px)').matches; }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = el('toast'); t.textContent = msg; t.classList.add('open');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('open'), 2200);
  }
  AM.toast = toast;

  // ---------- view switching ----------
  function setView(name) {
    AM.state.view = name;
    $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (mobile()) body.classList.remove('side-open');
    AM.emit('view', name);
  }
  AM.setView = setView;

  // ---------- backdrop / palette coordination ----------
  const backdrop = el('backdrop'), palette = el('palette'), paletteInput = el('paletteInput');
  function backdropState() {
    backdrop.classList.toggle('open',
      palette.classList.contains('open') ||
      el('review').classList.contains('open') ||
      body.classList.contains('side-open'));
  }
  AM.backdropState = backdropState;

  // ---------- theme ----------
  function theme() {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = cur;
    try { localStorage.setItem('am-theme', cur); } catch (e) {}
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = cur === 'dark' ? '#000000' : '#f5f5f7';
    toast(cur === 'dark' ? 'Black appearance' : 'White appearance');
  }
  AM.theme = theme;

  // ---------- command palette ----------
  const COMMANDS = [
    { id: 'spawn', glyph: '＋', label: 'Spawn agent', key: 'A' },
    { id: 'goal', glyph: '◎', label: 'Assign goal to HEAD' },
    { id: 'chats', glyph: '▤', label: 'Open chats' },
    { id: 'workbench', glyph: '⌥', label: 'Open code workbench', key: 'C' },
    { id: 'mesh', glyph: '◈', label: 'Open agent mesh', key: 'M' },
    { id: 'autopilot', glyph: '⏵', label: 'Open autopilot' },
    { id: 'review', glyph: '✓', label: 'Open review queue', key: 'R' },
    { id: 'theme', glyph: '◐', label: 'Toggle black / white', key: 'T' },
    { id: 'settings', glyph: '⚙', label: 'Open settings' },
    { id: 'stop', glyph: '■', label: 'Stop all agents', danger: true },
  ];
  function renderPalette(q) {
    q = (q || '').toLowerCase().trim();
    const list = el('paletteList'); list.innerHTML = '';
    COMMANDS.filter((c) => !q || c.label.toLowerCase().indexOf(q) !== -1).forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'palette-item' + (i === 0 ? ' selected' : '');
      b.type = 'button'; b.dataset.command = c.id;
      b.innerHTML = '<span>' + c.glyph + '</span>' + esc(c.label) + (c.key ? '<span class="key">' + c.key + '</span>' : '');
      b.onclick = () => runCommand(c.id);
      list.appendChild(b);
    });
  }
  function openPalette(on) {
    palette.classList.toggle('open', on); backdropState();
    if (on) { paletteInput.value = ''; renderPalette(''); requestAnimationFrame(() => paletteInput.focus()); }
  }
  AM.openPalette = openPalette;
  function runCommand(id) {
    openPalette(false);
    switch (id) {
      case 'spawn': spawnMenu(el('addAgent')); break;
      case 'goal': focusGoal(); break;
      case 'chats': setView('chats'); break;
      case 'workbench': setView('workbench'); break;
      case 'mesh': setView('mesh'); break;
      case 'autopilot': setView('autopilot'); break;
      case 'review': if (AM.openReview) AM.openReview(true); else toast('Nothing to review yet'); break;
      case 'theme': theme(); break;
      case 'settings': AM.openSettings(true); break;
      case 'stop': mesh.stopAll(); toast('Stop signal sent to all agents'); break;
    }
  }

  function focusGoal() {
    const head = AM.headOf(AM.state.selectedFolderId) || (AM.state.panes.find((p) => p.role === 'head') || {}).id;
    if (!head) { toast('No HEAD agent yet — spawn one first'); return; }
    AM.selectAgent(head);
    if (AM.setGoalMode) AM.setGoalMode(true);
    const input = el('messageInput'); if (input) input.focus();
  }
  AM.focusGoal = focusGoal;

  // ---------- mini menu (spawn presets, agent actions) ----------
  let openMenu = null, openAnchor = null;
  function closeMiniMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; openAnchor = null; document.removeEventListener('mousedown', onDocDown, true); }
  }
  function onDocDown(e) {
    if (!openMenu || openMenu.contains(e.target)) return;
    // Let the anchor button's own click toggle the menu closed — if we close
    // here on mousedown, its click instantly reopens it ("naka-pin" bug).
    if (openAnchor && openAnchor.contains && openAnchor.contains(e.target)) return;
    closeMiniMenu();
  }
  function miniMenu(anchor, options, cb) {
    if (openMenu && openAnchor === anchor) { closeMiniMenu(); return; } // toggle close
    closeMiniMenu();
    openAnchor = anchor;
    const menu = document.createElement('div'); menu.className = 'minimenu';
    options.forEach((o) => {
      if (o === '-') { const s = document.createElement('div'); s.className = 'minimenu-sep'; menu.appendChild(s); return; }
      const label = typeof o === 'string' ? o : o.label;
      const value = typeof o === 'string' ? o : o.value;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'minimenu-item';
      b.innerHTML = esc(label) + (o.tag ? '<span class="tag">' + esc(o.tag) + '</span>' : '');
      b.onclick = () => { closeMiniMenu(); cb(value); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    openMenu = menu; // (this was never set — menus could NEVER be closed)
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = r.top - h - 6; // flip up (side-foot sits low)
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  }
  AM.miniMenu = miniMenu;

  const PRESETS = [
    { label: 'Claude', value: 'claude', tag: 'autonomous' },
    { label: 'Codex', value: 'codex', tag: 'autonomous' },
    { label: 'Grok', value: 'grok', tag: 'autonomous' },
    { label: 'Aider', value: 'aider', tag: 'autonomous' },
    { label: 'Shell', value: 'shell' },
  ];
  function spawnMenu(anchor) {
    if (!AM.state.folders.length) { addFolder(); return; }
    if (!AM.state.selectedFolderId) AM.state.selectedFolderId = AM.state.folders[0].id;
    miniMenu(anchor || el('addAgent'), PRESETS, (preset) => {
      if (AM.spawnAgent) AM.spawnAgent(AM.state.selectedFolderId, preset);
      else toast('Agent spawning wires up next');
    });
  }
  AM.spawnMenu = spawnMenu;

  // ---------- sidebar ----------
  // Real explicit wires (matches the Mesh view) — strictly directed (FEAT-005).
  function totalWires() { return (AM.state.wires || []).length; }
  const collapsedParents = new Set();
  const collapsedFolders = new Set();

  // AM-FEAT-005 workspace tree: independent roots, recursive children under
  // their Parent, crowns for every HEAD, and directed route badges (→ / ←).
  function folderEl(f) {
    const wrap = document.createElement('div');
    const selected = f.id === AM.state.selectedFolderId;
    const collapsed = collapsedFolders.has(f.id);
    const proj = document.createElement('button');
    proj.className = 'project'; proj.type = 'button';
    const branch = f.isGit ? (f.baseBranch || 'main') : (f.exists ? 'no git' : 'missing');
    proj.innerHTML = '<span class="quiet">' + (collapsed ? '›' : '⌄') + '</span><span class="folder"></span><span>' +
      esc(f.name) + '</span><span class="branch mono">' + esc(branch) + '</span>';
    // First click selects (and expands); clicking the selected folder toggles collapse.
    proj.onclick = () => {
      if (selected) {
        if (collapsedFolders.has(f.id)) collapsedFolders.delete(f.id); else collapsedFolders.add(f.id);
      } else {
        AM.state.selectedFolderId = f.id;
        collapsedFolders.delete(f.id);
        AM.emit('selectFolder', f.id);
      }
      renderSidebar();
    };
    wrap.appendChild(proj);

    if (!collapsed) {
      const box = document.createElement('div'); box.className = 'agents'; box.dataset.folder = f.id;
      const agents = AM.agentsInFolder(f.id);
      if (!agents.length && selected) {
        const hint = document.createElement('div'); hint.className = 'agent-task';
        hint.style.cssText = 'padding:2px 12px 8px'; hint.textContent = 'No agents — use ＋ Agent below';
        box.appendChild(hint);
      }
      const ids = {}; agents.forEach((a) => { ids[a.id] = a; });
      const roots = agents.filter((a) => !a.parentId || !ids[a.parentId]);
      const visited = new Set();
      roots.forEach((a) => appendTreeNode(a, box, agents, visited));
      // orphan safety: anything unvisited (parent cycle in stale data) renders flat
      agents.forEach((a) => { if (!visited.has(a.id)) appendTreeNode(a, box, agents, visited); });
      wrap.appendChild(box);
    }
    return wrap;
  }
  function appendTreeNode(a, container, agents, visited) {
    if (visited.has(a.id)) return;
    visited.add(a.id);
    const children = agents.filter((x) => x.parentId === a.id);
    const wrap = document.createElement('div'); wrap.className = 'workspace-node';
    const line = document.createElement('div'); line.className = 'workspace-line';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'workspace-toggle' + (children.length ? '' : ' empty');
    toggle.textContent = collapsedParents.has(a.id) ? '›' : '⌄';
    toggle.setAttribute('aria-label', (collapsedParents.has(a.id) ? 'Expand ' : 'Collapse ') + a.id);
    toggle.onclick = (e) => {
      e.stopPropagation();
      if (collapsedParents.has(a.id)) collapsedParents.delete(a.id); else collapsedParents.add(a.id);
      renderSidebar();
    };
    line.appendChild(toggle);
    line.appendChild(treeRow(a, children.length));
    wrap.appendChild(line);
    if (children.length) {
      const kids = document.createElement('div'); kids.className = 'workspace-children';
      kids.hidden = collapsedParents.has(a.id);
      children.forEach((c) => appendTreeNode(c, kids, agents, visited));
      wrap.appendChild(kids);
    }
    container.appendChild(wrap);
  }
  function treeRow(a, childCount) {
    const head = a.role === 'head';
    const tier = AM.roleTier(a);
    const brand = AM.agentBrand(a.agentType);
    const micro = AM.microStatus(a.id);
    const unread = AM.unreadFor ? AM.unreadFor(a.id) : 0;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'agent workspace-agent ' + brand.cls + ' tier-' + tier
      + (a.parentId && tier === 'parent' ? ' is-sub' : '')
      + (a.id === AM.state.selectedAgentId ? ' active' : '');
    b.dataset.agent = a.id;
    b.title = (head ? 'HEAD · ' : '') + (a.parentId ? 'Parent ' + a.parentId : 'Independent') + ' · select terminal';
    const port = a.exited ? '' : (micro.wait ? 'wait' : 'live');
    // directed route badges: → target (SEND) and ← source (RECEIVE)
    const routes = [];
    const peerSet = {};
    (AM.state.wires || []).forEach((w) => {
      if (w.from === a.id) { routes.push({ text: '→ ' + w.to, key: w.from + '>' + w.to }); peerSet[w.to] = 1; }
      else if (w.to === a.id) { routes.push({ text: '← ' + w.from, key: w.from + '>' + w.to }); peerSet[w.from] = 1; }
    });
    // "Independent" only when truly unwired — a wired terminal shows its link.
    let meta;
    if (a.parentId) meta = 'Subterminal · ' + a.parentId;
    else {
      const peers = Object.keys(peerSet).filter((pid) => AM.pane(pid));
      if (peers.length) {
        const headPeer = peers.find((pid) => { const pp = AM.pane(pid); return pp && pp.role === 'head'; });
        const primary = headPeer || peers[0];
        meta = 'Wired · ' + primary + (headPeer && a.role !== 'head' ? ' HEAD' : '');
        if (peers.length > 1) meta += ' +' + (peers.length - 1);
      } else meta = 'Independent';
    }
    if (childCount) meta += ' · ';
    let badges = unread ? '<span class="link-badge">' + (unread > 9 ? '9+' : unread) + '</span>' : '';
    routes.slice(0, 3).forEach((r) => {
      badges += '<span class="workspace-route" data-route-key="' + esc(r.key) + '">' + esc(r.text) + '</span>';
    });
    if (routes.length > 3) badges += '<span class="workspace-route">+' + (routes.length - 3) + '</span>';
    b.innerHTML =
      '<span class="agent-port ' + port + '"></span>' +
      '<span class="agent-copy"><span class="agent-line">' +
      '<span class="agent-badge">' + esc(brand.abbr) + '</span>' +
      (head ? '<span class="workspace-crown">♛</span>' : '') +
      '<span class="agent-name">' + esc(a.id) + ' <span>· ' + esc(a.agentType) + '</span></span></span>' +
      '<span class="agent-task">' + esc(micro.text) + '</span>' +
      '<span class="workspace-node-meta">' + esc(meta) + (childCount ? '<span class="workspace-parent-badge">Parent · ' + childCount + '</span>' : '') + '</span></span>' +
      '<span class="workspace-route-badges">' + badges + '</span>';
    b.onclick = () => AM.selectAgent(a.id);
    return b;
  }
  let sidebarSig = '';
  function sidebarSignature() {
    const st = AM.state;
    const agents = st.panes.map((a) => {
      const m = AM.microStatus(a.id);
      return [a.id, a.role, a.agentType, a.parentId, a.folderId, m.text, m.wait ? 1 : 0,
        AM.unreadFor ? AM.unreadFor(a.id) : 0, a.id === st.selectedAgentId ? 1 : 0].join('|');
    }).join(';');
    const folders = st.folders.map((f) => [f.id, f.name, f.baseBranch, f.isGit ? 1 : 0,
      f.id === st.selectedFolderId ? 1 : 0, collapsedFolders.has(f.id) ? 1 : 0].join('|')).join(';');
    const wires = (st.wires || []).map((w) => w.from + '>' + w.to).join(',');
    return folders + '#' + agents + '#' + wires + '#' + [...collapsedParents].join(',');
  }
  function renderSidebar(force) {
    const scroll = el('sideScroll'); const st = AM.state;
    // Skip identical re-renders: live agents fire snapshots constantly, and a
    // mid-click DOM rebuild swallows the user's click (collapse "not working").
    const sig = sidebarSignature();
    if (!force && sig === sidebarSig && scroll.children.length) return;
    sidebarSig = sig;
    scroll.innerHTML = '';
    if (!st.folders.length) {
      scroll.innerHTML =
        '<div class="empty" style="padding:44px 16px"><div class="glyph">◫</div><h3>No projects yet</h3>' +
        '<p>Add a project folder to start spawning agents inside it.</p>' +
        '<button class="button" id="emptyAddFolder" type="button">＋ Add folder</button></div>';
      const b = el('emptyAddFolder'); if (b) b.onclick = addFolder;
      return;
    }
    const eb = document.createElement('div'); eb.className = 'eyebrow mesh-label';
    const wires = totalWires();
    eb.innerHTML = '<span>Workspace</span>'
      + (wires ? '<span class="mesh-count"><span class="dot live"></span>' + wires + ' wire' + (wires === 1 ? '' : 's') + '</span>' : '')
      + '<button class="eyebrow-add" id="sideAddFolder" type="button" title="Add a project folder" aria-label="Add a project folder">＋</button>';
    scroll.appendChild(eb);
    const addBtn = el('sideAddFolder'); if (addBtn) addBtn.onclick = addFolder;
    st.folders.forEach((f) => scroll.appendChild(folderEl(f)));
    // Workbench Explorer (AM-FEAT-002) — filled by workbench.js for the selected agent.
    const explorer = document.createElement('section');
    explorer.className = 'explorer-section'; explorer.id = 'workspaceExplorer'; explorer.hidden = true;
    scroll.appendChild(explorer);
    if (AM.renderExplorer) AM.renderExplorer();
  }
  AM.renderSidebar = renderSidebar;

  // AM-FEAT-001/005: on real traffic, pulse ONLY the exact directed route —
  // the `from>to` badge plus the sender and receiver rows. Never decorative.
  AM.on('busmsg', (m) => {
    if (!m.from || !m.to) return;
    const fp = AM.pane(m.from), tp = AM.pane(m.to);
    if (!fp || !tp) return;
    const scroll = el('sideScroll');
    const key = m.from + '>' + m.to;
    const badges = scroll.querySelectorAll('.workspace-route[data-route-key="' + key + '"]');
    const srcRow = scroll.querySelector('.workspace-agent[data-agent="' + fp.id + '"]');
    const dstRow = scroll.querySelector('.workspace-agent[data-agent="' + tp.id + '"]');
    badges.forEach((b) => b.classList.add('live-signal'));
    if (srcRow) srcRow.classList.add('is-sending');
    if (dstRow) dstRow.classList.add('is-receiving');
    setTimeout(() => {
      badges.forEach((b) => b.classList.remove('live-signal'));
      if (srcRow) srcRow.classList.remove('is-sending');
      if (dstRow) dstRow.classList.remove('is-receiving');
    }, 1200);
  });

  // ---------- selection ----------
  function selectAgent(id) {
    AM.state.selectedAgentId = id;
    const p = AM.pane(id); if (p) AM.state.selectedFolderId = p.folderId;
    setView('chats');
    AM.emit('selectAgent', id);
    renderSidebar();
  }
  AM.selectAgent = selectAgent;

  // ---------- folder actions ----------
  async function addFolder() {
    let res;
    try { res = await mesh.addFolder(); } catch (e) { toast('Could not open folder picker'); return; }
    if (!res || res.ok === false) { if (!(res && res.canceled)) toast((res && res.error) || 'Could not add folder'); return; }
    AM.state.folders = await mesh.listFolders();
    if (res.folder) AM.state.selectedFolderId = res.folder.id;
    AM.emit('folders', AM.state.folders);
    renderSidebar();
    toast(res.existed ? 'Folder already added' : 'Folder added · ' + (res.folder ? res.folder.name : ''));
  }
  AM.addFolder = addFolder;

  // ---------- status bar ----------
  function renderStatus() {
    const st = AM.state, bar = el('statusBar');
    const agents = st.panes.length;
    const waiting = st.snapshot.locks.reduce((n, l) => n + (l.waiters ? l.waiters.length : 0), 0);
    const heads = st.panes.filter((p) => p.role === 'head').map((p) => p.id);
    const firstLock = st.snapshot.locks.find((l) => l.holder);
    const f = AM.folder(st.selectedFolderId);
    const cap = st.guard.max ? st.guard.max : '∞';
    const parts = [];
    parts.push('<span><span class="dot ' + (st.guard.paused ? 'wait' : 'live') + '"></span> ' + (st.guard.paused ? 'Paused' : 'Live') + '</span>');
    parts.push('<span class="sep">•</span><span>' + agents + ' agent' + (agents === 1 ? '' : 's') + '</span>');
    if (heads.length) parts.push('<span class="sep">•</span><span>HEAD ' + esc(heads.join(', ')) + '</span>');
    if (waiting) parts.push('<span class="sep">•</span><span>' + waiting + ' waiting</span>');
    if (firstLock) parts.push('<span class="sep">•</span><span class="mono">' + esc(firstLock.resource) + ' → ' + esc(firstLock.holder) + '</span>');
    parts.push('<span class="sep">•</span><span class="mono">' + st.guard.total + ' / ' + cap + ' exchanges</span>');
    if (st.cost && st.cost.totals && st.cost.totals.known) {
      parts.push('<span class="sep">•</span><span class="mono" title="Best-effort estimate from Claude transcripts">$' + st.cost.totals.usd.toFixed(2) + ' est</span>');
    }
    parts.push('<span class="push"></span>');
    parts.push('<span class="mono">' + (f ? esc(f.name) + (f.isGit ? ' · ' + esc(f.baseBranch || 'main') : '') : 'no folder') + '</span>');
    bar.innerHTML = parts.join('');
    // topbar brand repo chip (was unwired)
    el('repoLabel').textContent = f ? '/ ' + f.name : '';
  }
  AM.renderStatus = renderStatus;

  // ---------- inspector tab switching (content filled by inspector.js) ----------
  $$('.inspect-tabs button').forEach((b) => {
    b.onclick = () => {
      $$('.inspect-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + b.dataset.pane));
      AM.emit('inspectorTab', b.dataset.pane);
    };
  });

  // ---------- wire up static controls ----------
  $$('[data-view]').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  el('sideToggle').onclick = function () { body.classList.toggle(mobile() ? 'side-open' : 'side-off'); this.classList.toggle('active', !body.classList.contains('side-off')); backdropState(); };
  el('inspectToggle').onclick = function () {
    body.classList.toggle(compact() ? 'inspect-open' : 'inspect-off');
    this.classList.toggle('active', compact() ? body.classList.contains('inspect-open') : !body.classList.contains('inspect-off'));
  };
  el('themeToggle').onclick = theme;
  el('paletteOpen').onclick = () => openPalette(true);
  el('runPill').onclick = () => setView('autopilot');
  el('addFolder').onclick = addFolder;
  el('addAgent').onclick = function () { spawnMenu(this); };
  backdrop.onclick = () => { openPalette(false); if (AM.openReview) AM.openReview(false); body.classList.remove('side-open'); backdropState(); };
  paletteInput.oninput = function () { renderPalette(this.value); };

  // ---------- settings modal (Phase 5) ----------
  const settingsModal = el('settingsModal');
  async function openSettings(on) {
    settingsModal.hidden = !on;
    if (!on) return;
    let s;
    try { s = await mesh.settingsGet(); } catch (_) { s = null; }
    if (!s) return;
    el('setLaunchClaude').value = s.launch.claude || '';
    el('setLaunchCodex').value = s.launch.codex || '';
    el('setLaunchGrok').value = s.launch.grok || '';
    el('setLaunchAider').value = s.launch.aider || '';
    el('setShell').value = s.defaultShell || '';
    el('setTheme').value = s.themeDefault || 'dark';
    el('setActivation').value = s.defaultActivation || 'manual';
    const ef = s.effortFlags || {};
    el('setEffort').value = s.defaultEffort || 'high';
    el('setEffortClaude').value = ef.claude != null ? ef.claude : '--effort {level}';
    el('setEffortCodex').value = ef.codex || '';
    el('setEffortGrok').value = ef.grok || '';
    el('setEffortAider').value = ef.aider || '';
  }
  AM.openSettings = openSettings;
  el('settingsOpen').onclick = () => openSettings(settingsModal.hidden);
  el('settingsClose').onclick = () => openSettings(false);
  el('settingsSave').onclick = async () => {
    const patch = {
      launch: {
        claude: el('setLaunchClaude').value.trim() || 'claude --dangerously-skip-permissions',
        codex: el('setLaunchCodex').value.trim() || 'codex --dangerously-bypass-approvals-and-sandbox',
        grok: el('setLaunchGrok').value.trim() || 'grok --always-approve',
        aider: el('setLaunchAider').value.trim() || 'aider --yes-always',
      },
      effortFlags: {
        claude: el('setEffortClaude').value.trim(),
        codex: el('setEffortCodex').value.trim(),
        grok: el('setEffortGrok').value.trim(),
        aider: el('setEffortAider').value.trim(),
      },
      defaultEffort: el('setEffort').value,
      defaultShell: el('setShell').value.trim(),
      themeDefault: el('setTheme').value,
      defaultActivation: el('setActivation').value,
    };
    await mesh.settingsSet(patch);
    try { localStorage.setItem('am-theme', patch.themeDefault); } catch (e) {}
    toast('Settings saved — applies to new agents');
    openSettings(false);
  };

  // window controls (frameless)
  el('winMin').onclick = () => mesh.minimize();
  el('winMax').onclick = () => mesh.maximize();
  el('winClose').onclick = () => mesh.close();

  // keyboard
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(true); return; }
    if (e.key === 'Escape') {
      if (el('review').classList.contains('open')) { if (AM.openReview) AM.openReview(false); }
      else if (palette.classList.contains('open')) openPalette(false);
      else { body.classList.remove('side-open', 'inspect-open'); backdropState(); }
      closeMiniMenu();
    }
    if (palette.classList.contains('open') && e.key === 'Enter') {
      const v = $$('.palette-item').find((i) => !i.hidden);
      if (v) runCommand(v.dataset.command);
    }
  });
  addEventListener('resize', () => {
    if (!mobile()) body.classList.remove('side-open');
    if (!compact()) body.classList.remove('inspect-open');
    backdropState(); closeMiniMenu();
  });

  // ---------- re-render on store changes ----------
  AM.on('folders', () => { renderSidebar(); renderStatus(); });
  AM.on('panes', () => { renderSidebar(); renderStatus(); });
  AM.on('snapshot', () => { renderSidebar(); renderStatus(); });
  AM.on('guard', renderStatus);
  AM.on('selectFolder', renderSidebar);
  AM.on('wires', () => { renderSidebar(); renderStatus(); }); // keep the sidebar rail in sync with the mesh
  AM.on('cost', renderStatus);
})();
