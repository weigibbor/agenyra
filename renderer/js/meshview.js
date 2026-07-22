'use strict';
/* meshview.js — AM-FEAT-003/004/005: the editable, live node mesh on a canvas.
 *
 * Bound to REAL runtime state: nodes = live panes of the selected folder,
 * connections = the router's strictly DIRECTED wires (one wire per direction;
 * reciprocal pairs render as two separated curves with arrows), traffic =
 * real bus messages. HEAD is a user-assignable role (multiple allowed);
 * Parent hierarchy is organizational only and never implies a route.
 *
 * Gestures: drag node body to arrange (single-click = drag only, never opens a
 * panel) · pull the SEND port onto another node to create one directed route ·
 * DOUBLE-click a node to open the Mesh Inspector (Parent, activation, send/
 * receive routes) · right-click opens the role menu (HEAD / Normal / Inspector /
 * Open chat). Chat lives on right-click + dbl-click-in-sidebar, not node click. */
(function () {
  const AM = window.AM, mesh = AM.mesh, el = AM.el, esc = AM.esc;
  const root = el('liveMesh');
  const canvas = el('meshWireCanvas');
  const ctx = canvas.getContext('2d');
  const layer = el('meshNodeLayer');
  const config = el('meshConfig');
  const ctxMenu = el('meshContextMenu');
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

  const S = {
    initialized: false, running: false, reduced: motionQuery.matches,
    size: { width: 0, height: 0 }, dpr: 1,
    nodes: {}, connections: [], traffic: [],
    drag: null, guide: null, magnet: null, keyboardSource: null, suppressClick: false,
    raf: 0, justSpawned: null, selectedId: null, contextId: null, lastTap: null,
    // Wire-FX state: hot = 'src>tgt' -> last traffic time (wires glow then cool),
    // dying = removed wires fading out, ripples = impact rings, bg = starfield.
    hot: {}, dying: [], ripples: [], bg: null,
    // Infinite canvas camera: nodes live in unbounded WORLD px; the camera maps
    // world -> screen as (world - cam) * z. Pan = drag empty space, zoom = wheel.
    cam: { x: 0, y: 0, z: 1 }, _camSaveTimer: 0,
  };
  const HINT_DEFAULT = 'Drag space to pan · scroll to zoom · drag nodes · double-click to configure · pull a port to connect';
  const ZOOM_MIN = 0.1, ZOOM_MAX = 2.5;

  const nodesList = () => Object.keys(S.nodes).map((id) => S.nodes[id]);
  const folderAgents = () => AM.agentsInFolder(AM.state.selectedFolderId);
  const inMesh = () => AM.state.view === 'mesh';
  const openMeshOn = () => !!(AM.openMesh && AM.openMesh());
  const paneOf = (id) => AM.pane(id);
  const childrenOf = (id) => folderAgents().filter((a) => a.parentId === id);
  function posKey() { return 'am-meshpos3-' + (AM.state.selectedFolderId || ''); }
  function loadPos() {
    try {
      const v3 = JSON.parse(localStorage.getItem(posKey()) || 'null');
      if (v3) return v3;
    } catch (e) {}
    // Migrate the old viewport-relative spots (rx/ry in 0..1) into world px.
    try {
      const v2 = JSON.parse(localStorage.getItem('am-meshpos2-' + (AM.state.selectedFolderId || '')) || 'null');
      if (v2) {
        const w = S.size.width || 900, h = S.size.height || 560;
        const out = {};
        Object.keys(v2).forEach((id) => {
          if (v2[id] && typeof v2[id].rx === 'number') out[id] = { x: Math.round(v2[id].rx * w), y: Math.round(v2[id].ry * h) };
        });
        return out;
      }
    } catch (e) {}
    return {};
  }
  function savePos() {
    const out = { __cam: { x: Math.round(S.cam.x), y: Math.round(S.cam.y), z: +S.cam.z.toFixed(3) } };
    nodesList().forEach((n) => { out[n.id] = { x: Math.round(n.x), y: Math.round(n.y) }; });
    try { localStorage.setItem(posKey(), JSON.stringify(out)); } catch (e) {}
  }
  function loadCam() {
    const c = loadPos().__cam;
    S.cam = c
      ? { x: +c.x || 0, y: +c.y || 0, z: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +c.z || 1)) }
      : { x: 0, y: 0, z: 1 };
    // No saved camera for this folder yet → frame everything on first open so no
    // terminal starts off-screen out in the infinite canvas.
    S._needsFit = !c;
    applyCamera();
  }
  function statusOf(id) {
    const p = paneOf(id);
    if (!p) return 'idle';
    const micro = AM.microStatus(id);
    if (micro.wait) return 'waiting';
    if (AM.taskFor(id) || p.role === 'head' || AM.locksHeldBy(id).length) return 'working';
    return 'idle';
  }
  function wiredPeersOf(id) {
    const fid = (paneOf(id) || {}).folderId;
    const set = {};
    (AM.state.wires || []).forEach((w) => {
      if (w.from === id) set[w.to] = 1; else if (w.to === id) set[w.from] = 1;
    });
    return Object.keys(set).filter((pid) => { const p = paneOf(pid); return p && p.folderId === fid; });
  }
  const isHeadPane = (id) => { const p = paneOf(id); return !!(p && p.role === 'head'); };
  // AM-FEAT-005: parent hierarchy ≠ wires. But "Independent" while clearly wired
  // reads as wrong — so a wired terminal shows its link (a HEAD if it has one).
  function metaOf(id) {
    const p = paneOf(id);
    if (!p) return '';
    const kids = childrenOf(id).length;
    let meta;
    if (p.parentId) meta = 'Subterminal · ' + p.parentId;
    else if (openMeshOn()) meta = 'Open mesh'; // everyone reachable — "Independent" would read as wrong
    else {
      const peers = wiredPeersOf(id);
      if (peers.length) {
        const head = peers.find(isHeadPane);
        const primary = head || peers[0];
        meta = 'Wired · ' + primary + (head && !isHeadPane(id) ? ' HEAD' : '');
        if (peers.length > 1) meta += ' +' + (peers.length - 1);
      } else meta = 'Independent';
    }
    if (kids) meta += ' · Parent · ' + kids;
    return meta;
  }

  // ---------- metrics + guard panel ----------
  function updateMetrics() {
    const agents = folderAgents();
    const waiting = agents.filter((a) => AM.microStatus(a.id).wait).length;
    el('mAgents').textContent = agents.length;
    el('mAgentsNote').textContent = agents.length ? (agents.length - waiting) + ' active · ' + waiting + ' waiting' : 'none yet';
    el('mExch').textContent = AM.state.guard.total;
    el('mExchNote').textContent = 'of ' + (AM.state.guard.max || '∞') + ' allowed';
    // best-effort cost (4B): real numbers when Claude transcripts are readable, '—' otherwise
    const cost = AM.state.cost;
    if (cost && cost.totals && cost.totals.known) {
      const t = cost.totals.tokens;
      el('mTokens').textContent = t >= 1000 ? (t / 1000).toFixed(1) + 'k' : String(t);
      el('mTokens').classList.remove('na');
      el('mSpend').textContent = '$' + cost.totals.usd.toFixed(2);
      el('mSpend').classList.remove('na');
    }
    const conn = el('meshConn');
    const wires = S.connections.length;
    conn.innerHTML = agents.length
      ? '<span class="dot live"></span>' + (openMeshOn()
        ? 'Open mesh' + (wires ? ' · ' + wires + ' wire' + (wires === 1 ? '' : 's') : '')
        : wires + ' wire' + (wires === 1 ? '' : 's'))
      : '<span class="dot"></span>Idle';
    const f = AM.folder(AM.state.selectedFolderId);
    el('meshTitle').textContent = f ? f.name + ' mesh' : 'Agent mesh';
  }
  function updateGuardPanel() {
    const g = AM.state.guard;
    el('capValue').textContent = g.max || '∞';
    el('capUsed').textContent = g.total;
    el('loopState').textContent = 'On';
    el('guardStatus').textContent = g.paused ? 'Paused' : 'Running';
    el('guardStatus').title = g.paused ? (AM.state.guardReason || 'guard') : '';
    const chip = el('guardArmed');
    chip.textContent = g.paused ? 'Paused' : 'Armed';
    chip.style.color = g.paused ? 'var(--warn)' : 'var(--good)';
  }

  // ---------- geometry ----------
  // World px is unbounded — the mesh is an infinite canvas; the camera decides
  // what's visible. No clamping: many terminals simply spread out in space.
  function applyCamera() {
    const c = S.cam;
    // Only the transform + grid offset change while panning — the GPU composites
    // the transform, so this stays cheap at 60fps. backgroundSize + zoom label
    // depend on zoom alone, so skip them unless the zoom actually changed.
    layer.style.transform = 'scale(' + c.z + ') translate(' + (-c.x) + 'px,' + (-c.y) + 'px)';
    root.style.backgroundPosition = (-c.x * c.z) + 'px ' + (-c.y * c.z) + 'px';
    if (S._appliedZoom !== c.z) {
      S._appliedZoom = c.z;
      root.style.backgroundSize = (22 * c.z) + 'px ' + (22 * c.z) + 'px';
      const zl = el('meshZoomLabel');
      if (zl) zl.textContent = Math.round(c.z * 100) + '%';
    }
    redraw();
  }
  // Coalesce pan updates: pointermove can fire faster than the display refresh, so
  // apply the camera at most once per animation frame (in lockstep with the canvas
  // rAF loop, which reads S.cam) instead of writing styles on every pointer event.
  let _panRaf = 0;
  function schedulePan() {
    if (_panRaf) return;
    _panRaf = requestAnimationFrame(() => { _panRaf = 0; applyCamera(); });
  }
  function scheduleCamSave() {
    clearTimeout(S._camSaveTimer);
    S._camSaveTimer = setTimeout(savePos, 400);
  }
  function toWorld(sx, sy) { return { x: sx / S.cam.z + S.cam.x, y: sy / S.cam.z + S.cam.y }; }
  function setZoom(nz, px, py) {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nz));
    const cx = px === undefined ? S.size.width / 2 : px;
    const cy = py === undefined ? S.size.height / 2 : py;
    const w = toWorld(cx, cy); // keep the world point under the cursor fixed
    S.cam.z = z;
    S.cam.x = w.x - cx / z;
    S.cam.y = w.y - cy / z;
    applyCamera();
    scheduleCamSave();
  }
  function placeNode(n) {
    if (!n || !S.initialized) return;
    n.element.style.left = n.x + 'px';
    n.element.style.top = n.y + 'px';
  }
  function endpoint(id, type) {
    const n = S.nodes[id]; if (!n) return { x: 0, y: 0 };
    const half = n.element.offsetWidth / 2 || 82;
    return { x: n.x + (type === 'output' ? half : -half), y: n.y };
  }
  // Reciprocal pairs get a perpendicular offset so the two directed curves
  // never overlap (AM-FEAT-005).
  function curveOf(source, target, targetPoint) {
    const a = endpoint(source, 'output');
    const b = targetPoint || endpoint(target, 'input');
    let off = 0;
    if (!targetPoint && S.connections.some((e) => e.source === target && e.target === source)) {
      off = source < target ? 9 : -9;
    }
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * off, py = (dx / len) * off;
    const bend = Math.max(56, Math.min(180, Math.abs(dx) * 0.52));
    return {
      a: { x: a.x + px, y: a.y + py }, b: { x: b.x + px, y: b.y + py },
      c1: { x: a.x + bend + px, y: a.y + py }, c2: { x: b.x - bend + px, y: b.y + py },
    };
  }
  function pointOn(c, t) {
    const u = 1 - t;
    return {
      x: u * u * u * c.a.x + 3 * u * u * t * c.c1.x + 3 * u * t * t * c.c2.x + t * t * t * c.b.x,
      y: u * u * u * c.a.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.b.y,
    };
  }
  // Allocation-free variant for the per-frame particle/trail loops.
  const scratchP = { x: 0, y: 0 };
  function pointInto(c, t, out) {
    const u = 1 - t;
    out.x = u * u * u * c.a.x + 3 * u * u * t * c.c1.x + 3 * u * t * t * c.c2.x + t * t * t * c.b.x;
    out.y = u * u * u * c.a.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.b.y;
    return out;
  }
  function traceCurve(c, progress) {
    ctx.beginPath();
    ctx.moveTo(c.a.x, c.a.y);
    const steps = 26, limit = Math.max(1, Math.round(steps * progress));
    for (let i = 1; i <= limit; i++) {
      const p = pointOn(c, Math.min(progress, i / steps));
      ctx.lineTo(p.x, p.y);
    }
  }
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  // Full-curve Path2D cached per edge (rebuilt only when the endpoints move).
  function edgePath(edge, c) {
    const key = (c.a.x | 0) + ',' + (c.a.y | 0) + ',' + (c.b.x | 0) + ',' + (c.b.y | 0);
    if (edge._pathKey !== key) {
      const p = new Path2D();
      p.moveTo(c.a.x, c.a.y);
      p.bezierCurveTo(c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.b.x, c.b.y);
      edge._pathKey = key;
      edge._path = p;
    }
    return edge._path;
  }
  // CSS vars arrive as hex or rgb(); gradients need per-stop alpha. withAlpha ran
  // ~5×/edge/frame and re-parsed the color via regex each time (>60 wires ≈ 18k
  // regex/s). Parse each distinct color string ONCE into an "r,g,b" prefix and
  // cache it — the handful of theme colors are stable, so the regex never re-runs.
  const _rgbCache = Object.create(null);
  function rgbOf(color) {
    color = String(color || '').trim();
    if (color in _rgbCache) return _rgbCache[color];
    let out = null, m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(color))) {
      const h = m[1];
      out = parseInt(h[0] + h[0], 16) + ',' + parseInt(h[1] + h[1], 16) + ',' + parseInt(h[2] + h[2], 16);
    } else if ((m = /^#([0-9a-f]{6})$/i.exec(color))) {
      const h = m[1];
      out = parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16);
    } else if ((m = /^rgba?\(([^)]+)\)/.exec(color))) {
      out = m[1].split(',').slice(0, 3).join(',');
    }
    _rgbCache[color] = out;
    return out;
  }
  function withAlpha(color, a) {
    const rgb = rgbOf(color);
    return rgb ? 'rgba(' + rgb + ',' + a + ')' : String(color || '');
  }
  // Wires stay bright for ~1s after real traffic runs over them, then cool.
  function heatOf(source, target, now) {
    const key = source + '>' + target;
    const t = S.hot[key];
    if (!t) return 0;
    const h = Math.exp(-(now - t) / 900);
    if (h < 0.02) { delete S.hot[key]; return 0; }
    return h;
  }
  function drawArrow(c, color, scale) {
    const s = scale || 1;
    const tip = pointOn(c, 0.985), back = pointOn(c, 0.9);
    const ang = Math.atan2(tip.y - back.y, tip.x - back.x);
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - 7 * s * Math.cos(ang - 0.42), tip.y - 7 * s * Math.sin(ang - 0.42));
    ctx.lineTo(tip.x - 7 * s * Math.cos(ang + 0.42), tip.y - 7 * s * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // Seeded starfield + vignette on an offscreen canvas — one drawImage per
  // frame buys the "game scene" depth without per-frame cost.
  function buildBackground(mutedColor, isLight) {
    if (!S.size.width || !S.size.height) return;
    const bg = document.createElement('canvas');
    bg.width = Math.round(S.size.width * S.dpr);
    bg.height = Math.round(S.size.height * S.dpr);
    const bctx = bg.getContext('2d');
    bctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    let seed = 1337;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    bctx.fillStyle = mutedColor || '#8a8a90';
    for (let i = 0; i < 64; i++) {
      const x = rnd() * S.size.width, y = rnd() * S.size.height;
      const r = 0.5 + rnd() * 0.8;
      bctx.globalAlpha = (isLight ? 0.08 : 0.12) + rnd() * (isLight ? 0.1 : 0.22);
      bctx.beginPath(); bctx.arc(x, y, r, 0, Math.PI * 2); bctx.fill();
    }
    if (!isLight) { // vignette pulls focus center — dark theme only
      const g = bctx.createRadialGradient(
        S.size.width / 2, S.size.height / 2, Math.min(S.size.width, S.size.height) * 0.3,
        S.size.width / 2, S.size.height / 2, Math.max(S.size.width, S.size.height) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.25)');
      bctx.globalAlpha = 1;
      bctx.fillStyle = g;
      bctx.fillRect(0, 0, S.size.width, S.size.height);
    }
    S.bg = bg;
  }
  // DOM port feedback for traffic: launch flash on the source output port,
  // impact ring on the target input port (CSS classes, reduced-motion aware).
  function portFlash(id, portType, cls) {
    const n = S.nodes[id]; if (!n) return;
    const port = n.element.querySelector('.graph-port.' + portType);
    if (!port) return;
    port.classList.remove(cls);
    void port.offsetWidth; // restart the animation on rapid traffic
    port.classList.add(cls);
    setTimeout(() => port.classList.remove(cls), cls === 'port-hit' ? 340 : 220);
  }

  // ---------- canvas frame ----------
  // Layered "game scene" renderer: starfield → dying wires → open-mesh ambient
  // links → wires (glow + gradient luminance wave + particles + arrow pop) →
  // drag guide → traffic comets → impact ripples. Additive blending on dark;
  // reduced-motion = one static frame (no loop, no particles/comets/ripples).
  function drawFrame(now) {
    S.raf = 0;
    if (!inMesh() || !S.initialized) { S.running = false; return; }
    const styles = getComputedStyle(root);
    const textColor = styles.getPropertyValue('--text').trim();
    const mutedColor = styles.getPropertyValue('--muted').trim();
    const goodColor = styles.getPropertyValue('--good').trim();
    const headColor = styles.getPropertyValue('--head').trim() || textColor;
    const isLight = document.documentElement.dataset.theme === 'light';
    const add = !isLight; // additive glow blooms white on a white bg — dark only
    const dt = S._lastNow ? Math.min(0.05, (now - S._lastNow) / 1000) : 0.016;
    S._lastNow = now;
    // Clear in screen space, then draw everything else in WORLD space through
    // the camera: screen = (world - cam) * z (same mapping as the node layer).
    const cz = S.cam.z;
    const camTransform = () =>
      ctx.setTransform(S.dpr * cz, 0, 0, S.dpr * cz, -S.cam.x * cz * S.dpr, -S.cam.y * cz * S.dpr);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.size.width, S.size.height);
    camTransform();

    // background ambience (rebuilt when the theme flips)
    const themeKey = isLight ? 'l' : 'd';
    if (!S.bg || S._bgTheme !== themeKey) { S._bgTheme = themeKey; buildBackground(mutedColor, isLight); }
    if (S.bg) {
      ctx.save();
      ctx.globalAlpha = S.reduced ? 0.45 : 0.38 + 0.12 * Math.sin(now / 7000);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(S.bg, 0, 0);
      ctx.restore();
      camTransform();
    }

    const wireCount = S.connections.length;
    const lite = wireCount > 60;   // core stroke only
    const fewer = wireCount > 40;  // 1 particle per wire

    // dying wires fade out instead of vanishing
    if (S.dying.length) {
      S.dying = S.dying.filter((d) => {
        const e = (now - d.diedAt) / 260;
        if (e >= 1 || S.reduced) return false;
        ctx.save();
        if (add) ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.35 * (1 - e) * (1 - e);
        ctx.strokeStyle = d.head ? headColor : mutedColor;
        ctx.lineWidth = 1.4 * (1 - e) + 0.4;
        ctx.beginPath();
        ctx.moveTo(d.c.a.x, d.c.a.y);
        ctx.bezierCurveTo(d.c.c1.x, d.c.c1.y, d.c.c2.x, d.c.c2.y, d.c.b.x, d.c.b.y);
        ctx.stroke();
        ctx.restore();
        return true;
      });
    }

    // open mesh: ghost links between every unwired pair — they brighten
    // briefly when traffic runs over them, real wires keep the full treatment
    if (openMeshOn()) {
      const ids = Object.keys(S.nodes);
      if (ids.length > 1 && ids.length <= 12) {
        ctx.save();
        if (add) ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = mutedColor;
        ctx.lineWidth = 0.8;
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const a = S.nodes[ids[i]], b = S.nodes[ids[j]];
            const wired = S.connections.some((e) =>
              (e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id));
            if (wired) continue;
            const h = S.reduced ? 0 : Math.max(heatOf(a.id, b.id, now), heatOf(b.id, a.id, now));
            ctx.globalAlpha = (isLight ? 0.1 : 0.07) + h * 0.3;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    // wires
    S.connections.forEach((edge, index) => {
      if (!S.nodes[edge.source] || !S.nodes[edge.target]) return;
      const c = curveOf(edge.source, edge.target);
      const head = !!(paneOf(edge.source) && paneOf(edge.source).role === 'head');
      const working = S.nodes[edge.source].status === 'working';
      const color = head ? headColor : mutedColor;
      const heat = S.reduced ? 0 : heatOf(edge.source, edge.target, now);
      const age = now - edge.createdAt;
      const progress = S.reduced ? 1 : Math.min(1, age / 420);
      const eased = easeOutCubic(progress);
      const breath = S.reduced ? 0.42 : (head ? 0.5 : 0.4) + 0.08 * Math.sin(now / 4000 + index * 1.7);
      const boost = 1 + heat * 0.9 + (working ? 0.2 : 0);
      const path = progress === 1 ? edgePath(edge, c) : null;

      ctx.save();
      if (add) ctx.globalCompositeOperation = 'lighter';
      if (add && !lite && !S.reduced) { // wide soft glow (layered stroke, no shadowBlur)
        ctx.globalAlpha = 0.07 * boost;
        ctx.strokeStyle = color;
        ctx.lineWidth = head ? 8 : 6.5;
        if (path) ctx.stroke(path); else { traceCurve(c, eased); ctx.stroke(); }
      }
      if (!lite) { // mid halo
        ctx.globalAlpha = (isLight ? 0.1 : 0.15) * boost;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        if (path) ctx.stroke(path); else { traceCurve(c, eased); ctx.stroke(); }
      }
      // bright core: gradient dim→bright toward the arrow, with a traveling
      // luminance band flowing source→target (replaces the old dash scroll)
      const w = S.reduced ? 0.5 : (now / 2600 + index * 0.37) % 1;
      const grad = ctx.createLinearGradient(c.a.x, c.a.y, c.b.x, c.b.y);
      const base = isLight ? 0.5 : 0.34;
      grad.addColorStop(0, withAlpha(color, base * 0.6));
      if (!S.reduced) {
        if (w > 0.14) grad.addColorStop(w - 0.14, withAlpha(color, base));
        grad.addColorStop(w, withAlpha(color, isLight ? 0.95 : 1));
        if (w < 0.9) grad.addColorStop(w + 0.1, withAlpha(color, base));
      }
      grad.addColorStop(1, withAlpha(color, isLight ? 0.8 : 0.7));
      ctx.globalAlpha = Math.min(1, breath + heat * 0.4);
      ctx.strokeStyle = grad;
      ctx.lineWidth = (head ? 1.7 : 1.25) + heat * 0.9;
      if (path) ctx.stroke(path); else { traceCurve(c, eased); ctx.stroke(); }
      ctx.restore();

      if (progress === 1) {
        // arrow pops in with a 160ms overshoot right after draw-in
        let scale = 1;
        if (!S.reduced && age < 580) scale = 1.6 - 0.6 * easeOutCubic((age - 420) / 160);
        drawArrow(c, color, scale);
        if (!S.reduced && age < 760) { // brief tip spark
          const sp = 1 - Math.max(0, age - 420) / 340;
          ctx.save();
          ctx.globalAlpha = 0.8 * sp;
          ctx.fillStyle = head ? headColor : textColor;
          ctx.shadowColor = head ? headColor : textColor;
          ctx.shadowBlur = 8;
          pointInto(c, 0.985, scratchP);
          ctx.beginPath(); ctx.arc(scratchP.x, scratchP.y, 2.4 * sp + 0.6, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
        // flow particles — constant directional energy along the wire
        if (!S.reduced) {
          if (!edge.dots || (fewer && edge.dots.length > 1)) {
            const len = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
            const n = fewer ? 1 : Math.max(2, Math.min(4, 2 + Math.floor(len / 220)));
            edge.dots = [];
            for (let i = 0; i < n; i++) {
              edge.dots.push({
                t: (i / n + index * 0.13) % 1,
                speed: 0.08 + ((index * 7 + i * 13) % 9) * 0.009,
                size: 1.1 + ((index * 5 + i * 11) % 10) * 0.09,
              });
            }
          }
          ctx.save();
          if (add) ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = color;
          for (let i = 0; i < edge.dots.length; i++) {
            const d = edge.dots[i];
            d.t = (d.t + d.speed * (1 + heat * 1.6) * dt) % 1;
            pointInto(c, d.t, scratchP);
            ctx.globalAlpha = 0.16; // soft halo (bigger dot, no shadowBlur)
            ctx.beginPath(); ctx.arc(scratchP.x, scratchP.y, d.size * 2.4, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 0.75;
            ctx.beginPath(); ctx.arc(scratchP.x, scratchP.y, d.size, 0, Math.PI * 2); ctx.fill();
          }
          ctx.restore();
        }
      }
    });

    // drag guide: dashed with a faint glow underlay
    if (S.drag && S.drag.type === 'connect' && S.guide) {
      const target = S.magnet ? endpoint(S.magnet, 'input') : S.guide;
      const gc = curveOf(S.drag.source, null, target);
      ctx.save();
      if (add) ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = textColor;
      ctx.lineWidth = 5;
      traceCurve(gc, 1);
      ctx.stroke();
      ctx.globalAlpha = 0.82;
      ctx.lineWidth = 1.35;
      ctx.setLineDash([4, 5]);
      ctx.lineDashOffset = S.reduced ? 0 : -now / 34;
      traceCurve(gc, 1);
      ctx.stroke();
      ctx.restore();
    }

    // traffic comets: bright head + fading trail; impact ripple on arrival
    S.traffic = S.traffic.filter((sig) => {
      const elapsed = now - sig.started;
      const edge = S.connections.find((e) => e.source === sig.source && e.target === sig.target);
      if (!edge && !(sig.virtual && S.nodes[sig.source] && S.nodes[sig.target])) return false;
      const c = curveOf(sig.source, sig.target);
      if (!sig._flashed) { sig._flashed = true; portFlash(sig.source, 'output', 'tx-flash'); }
      if (elapsed > sig.duration) {
        pointInto(c, 1, scratchP);
        if (!S.reduced) S.ripples.push({ x: scratchP.x, y: scratchP.y, started: now });
        portFlash(sig.target, 'input', 'port-hit');
        return false;
      }
      if (!S.reduced) {
        const t = Math.min(1, elapsed / sig.duration);
        ctx.save();
        if (add) ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = goodColor;
        for (let i = 6; i >= 1; i--) { // trail
          const tt = t - i * 0.02;
          if (tt <= 0) continue;
          pointInto(c, tt, scratchP);
          ctx.globalAlpha = (0.06 + (0.3 * (6 - i)) / 6) * (sig.virtual ? 0.7 : 1);
          ctx.beginPath(); ctx.arc(scratchP.x, scratchP.y, 0.8 + ((6 - i) / 6) * 2.2, 0, Math.PI * 2); ctx.fill();
        }
        pointInto(c, t, scratchP);
        ctx.globalAlpha = sig.virtual ? 0.75 : 0.95;
        ctx.shadowColor = goodColor;
        ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(scratchP.x, scratchP.y, sig.virtual ? 2.8 : 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      return true;
    });

    // impact ripples at the target port
    if (S.ripples.length) {
      S.ripples = S.ripples.filter((r) => {
        const e = (now - r.started) / 420;
        if (e >= 1 || S.reduced) return false;
        const k = 1 - (1 - e) * (1 - e);
        ctx.save();
        ctx.globalAlpha = 0.8 * (1 - e);
        ctx.strokeStyle = goodColor;
        ctx.shadowColor = goodColor;
        ctx.shadowBlur = 6;
        ctx.lineWidth = 2 - 1.4 * e;
        ctx.beginPath(); ctx.arc(r.x, r.y, 4 + 14 * k, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        return true;
      });
    }

    if (!S.reduced && S.running) S.raf = requestAnimationFrame(drawFrame);
  }
  function redraw() {
    if (!S.initialized) return;
    if (S.reduced) { drawFrame(performance.now()); return; }
    if (!S.raf) S.raf = requestAnimationFrame(drawFrame);
  }
  function resizeCanvas() {
    const rect = root.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    // ResizeObserver fires on layout ticks that don't change our size; skip them
    // so the starfield isn't rebuilt every frame during a window drag.
    if (S.initialized && w === S.size.width && h === S.size.height && dpr === S.dpr) return;
    S.size = { width: w, height: h };
    S.dpr = dpr;
    canvas.width = Math.round(w * S.dpr);
    canvas.height = Math.round(h * S.dpr);
    S.bg = null; // starfield is size-dependent — rebuilt lazily next frame
    S.initialized = true;
    // Nodes are world-anchored — a viewport resize moves the window, not them.
    nodesList().forEach((n) => placeNode(n));
    applyCamera();
  }

  // ---------- node elements ----------
  // "Opus 4.8 1M · max effort" — real model + effort for this agent (shared store).
  function modelLine(id) {
    const info = AM.agentInfo && AM.agentInfo(id);
    if (!info) return '';
    const bits = [];
    if (info.model) bits.push(info.model);
    if (info.effort) bits.push(info.effort + ' effort');
    return bits.join(' · ');
  }
  function buildNodeEl(n) {
    const p = paneOf(n.id) || {};
    const head = p.role === 'head';
    const tier = AM.roleTier(p.id ? p : null);
    const brand = AM.agentBrand(n.model);
    const kids = childrenOf(n.id).length;
    const element = document.createElement('article');
    element.className = 'graph-node ' + brand.cls + (head ? ' head' : '') + ' tier-' + tier
      + (p.parentId && !head ? ' is-sub' : '') + (n.id === S.selectedId ? ' selected' : '');
    element.dataset.meshNode = n.id;
    element.setAttribute('aria-label', n.id + ', ' + tier.toUpperCase() + ', ' + n.status);
    const crown = head ? '<span class="graph-crown">♛</span>' : '';
    element.innerHTML =
      '<button class="graph-port input" type="button" data-port="input" aria-label="Connect into ' + esc(n.id) + '"></button>' +
      '<div class="graph-node-top"><span class="graph-status ' + esc(n.status) + '"></span>' +
      '<span class="agent-badge">' + esc(brand.abbr) + '</span>' + crown +
      '<span class="graph-node-name">' + esc(n.id) + '</span>' +
      '<span class="graph-role">' + esc((head ? 'HEAD · ' : '') + String(n.model).toUpperCase()) + '</span>' +
      (kids ? '<span class="tier-badge">P·' + kids + '</span>' : '') + '</div>' +
      '<div class="graph-model">' + esc(modelLine(n.id)) + '</div>' +
      '<div class="graph-task">' + esc(n.task) + '</div>' +
      '<div class="graph-node-meta">' + esc(metaOf(n.id)) + '</div>' +
      '<button class="graph-port output" type="button" data-port="output" aria-label="Drag from ' + esc(n.id) + ' to connect"></button>';
    element.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(n.id, e.clientX, e.clientY); });
    // NB: no dblclick listener here. The node's pointerdown takes pointer capture
    // on `root`, which per the Pointer Events spec redirects click/dblclick to the
    // capturing element — so an element-level dblclick would never fire. Double-
    // click is detected in finishPointer() (two quick no-move taps) instead.
    return element;
  }

  // ---------- role context menu ----------
  function openContextMenu(id, x, y) {
    S.contextId = id;
    const p = paneOf(id);
    el('meshContextLabel').textContent = id + ' · terminal role';
    ctxMenu.querySelectorAll('[data-mesh-role]').forEach((b) => {
      b.classList.toggle('active', p && ((b.dataset.meshRole === 'head') === (p.role === 'head')));
    });
    ctxMenu.hidden = false;
    const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }
  function closeContextMenu() { ctxMenu.hidden = true; S.contextId = null; }
  ctxMenu.addEventListener('click', (e) => {
    const id = S.contextId;
    const roleBtn = e.target.closest('[data-mesh-role]');
    const actBtn = e.target.closest('[data-mesh-action]');
    if (roleBtn && id) {
      mesh.setRole(id, roleBtn.dataset.meshRole === 'head' ? 'head' : 'worker');
      AM.toast(id + (roleBtn.dataset.meshRole === 'head' ? ' is now a HEAD' : ' is now a Normal terminal'));
    } else if (actBtn && id) {
      if (actBtn.dataset.meshAction === 'chat') AM.selectAgent(id);
      else selectNode(id);
    }
    closeContextMenu();
  });
  document.addEventListener('mousedown', (e) => { if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeContextMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeContextMenu(); if (S.keyboardSource) clearConnectMode(); } });

  // ---------- Mesh Inspector ----------
  function selectNode(id) {
    S.selectedId = id;
    nodesList().forEach((n) => n.element.classList.toggle('selected', n.id === id));
    renderMeshConfig();
  }
  function descendantsOf(id) {
    const out = new Set();
    const walk = (pid) => {
      folderAgents().forEach((a) => {
        if (a.parentId === pid && !out.has(a.id)) { out.add(a.id); walk(a.id); }
      });
    };
    walk(id);
    return out;
  }
  function fillSelect(select, options, placeholder) {
    select.replaceChildren();
    const none = document.createElement('option');
    none.value = ''; none.textContent = placeholder;
    select.appendChild(none);
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.id; opt.textContent = o.id + ' · ' + o.agentType;
      select.appendChild(opt);
    });
  }
  function connectionExists(source, target) {
    return S.connections.some((e) => e.source === source && e.target === target);
  }
  function renderMeshConfig() {
    const id = S.selectedId;
    const p = id ? paneOf(id) : null;
    if (!p) { config.hidden = true; return; }
    config.hidden = false;
    el('meshOpenMeshNote').hidden = !openMeshOn();
    const title = el('meshConfigTitle');
    title.textContent = id + ' · ' + p.agentType;
    title.className = 'mesh-config-title ' + AM.agentBrand(p.agentType).cls;
    el('meshConfigSubtitle').textContent = p.parentId ? 'Subterminal of ' + p.parentId : 'Independent terminal';
    const heads = folderAgents().filter((a) => a.role === 'head').length;
    const roleSummary = el('meshRoleSummary');
    roleSummary.textContent = p.role === 'head' ? '♛ HEAD terminal' : 'Normal terminal';
    roleSummary.classList.toggle('is-head', p.role === 'head');
    el('meshRoleHint').textContent = p.role === 'head' ? 'One of ' + heads + ' HEAD' + (heads === 1 ? '' : 's') : 'Right-click node to promote';
    const banned = descendantsOf(id);
    const parentOptions = folderAgents().filter((a) => a.id !== id && !banned.has(a.id));
    const parentSelect = el('meshParentSelect');
    fillSelect(parentSelect, parentOptions, 'None — Independent');
    parentSelect.value = p.parentId || '';
    el('meshActivationSelect').value = p.activationPolicy || 'manual';
    const outgoing = S.connections.filter((e) => e.source === id);
    const incoming = S.connections.filter((e) => e.target === id);
    fillSelect(el('meshSendTarget'), folderAgents().filter((a) => a.id !== id && !connectionExists(id, a.id)), 'Choose terminal…');
    fillSelect(el('meshReceiveSource'), folderAgents().filter((a) => a.id !== id && !connectionExists(a.id, id)), 'Choose terminal…');
    el('meshSendCount').textContent = outgoing.length + ' route' + (outgoing.length === 1 ? '' : 's');
    el('meshReceiveCount').textContent = incoming.length + ' route' + (incoming.length === 1 ? '' : 's');
    const sendList = el('meshSendList'), receiveList = el('meshReceiveList');
    sendList.replaceChildren(); receiveList.replaceChildren();
    const routeItem = (list, label, source, target, dir) => {
      const item = document.createElement('div'); item.className = 'mesh-route-item';
      item.innerHTML = '<span>' + dir + '</span><strong>' + esc(label) + '</strong>' +
        '<button type="button" data-remove-source="' + esc(source) + '" data-remove-target="' + esc(target) + '" aria-label="Remove ' + esc(source) + ' to ' + esc(target) + '">×</button>';
      list.appendChild(item);
    };
    outgoing.forEach((e) => routeItem(sendList, e.target, e.source, e.target, 'SEND →'));
    incoming.forEach((e) => routeItem(receiveList, e.source, e.source, e.target, 'RECEIVE ←'));
    if (!outgoing.length) { const d = document.createElement('div'); d.className = 'mesh-empty-route'; d.textContent = 'No terminal can receive from ' + id + '.'; sendList.appendChild(d); }
    if (!incoming.length) { const d = document.createElement('div'); d.className = 'mesh-empty-route'; d.textContent = id + ' receives from nobody.'; receiveList.appendChild(d); }
    const shortcut = el('meshConnectParent');
    shortcut.disabled = !p.parentId || (connectionExists(p.parentId, id) && connectionExists(id, p.parentId));
    shortcut.textContent = p.parentId ? 'Connect both directions with ' + p.parentId : 'Connect both directions with Parent';
  }
  el('meshConfigClose').onclick = () => { S.selectedId = null; nodesList().forEach((n) => n.element.classList.remove('selected')); renderMeshConfig(); };
  el('meshParentSelect').addEventListener('change', async function () {
    const id = S.selectedId; if (!id) return;
    const res = await mesh.setParent(id, this.value || null);
    if (res && res.ok === false) { AM.toast(res.error || 'Parent change rejected'); renderMeshConfig(); }
    else AM.toast(this.value ? id + ' is now a Subterminal of ' + this.value : id + ' is now independent');
  });
  el('meshActivationSelect').addEventListener('change', function () {
    const id = S.selectedId; if (!id) return;
    mesh.setActivation(id, this.value);
    AM.toast(id + ' activation: ' + this.value.replace(/_/g, ' '));
  });
  el('meshAddSend').onclick = () => {
    const id = S.selectedId, target = el('meshSendTarget').value;
    if (id && target) requestConnect(id, target);
  };
  el('meshAddReceive').onclick = () => {
    const id = S.selectedId, source = el('meshReceiveSource').value;
    if (id && source) requestConnect(source, id);
  };
  el('meshConnectParent').onclick = () => {
    const id = S.selectedId, p = id && paneOf(id);
    if (!p || !p.parentId) return;
    if (!connectionExists(p.parentId, id)) requestConnect(p.parentId, id);
    if (!connectionExists(id, p.parentId)) requestConnect(id, p.parentId);
  };
  config.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove-source]');
    if (rm) {
      mesh.removeWire(rm.dataset.removeSource, rm.dataset.removeTarget);
      AM.toast('Removed ' + rm.dataset.removeSource + ' → ' + rm.dataset.removeTarget);
    }
  });
  el('meshCloseAgent').onclick = () => {
    const id = S.selectedId; if (!id) return;
    mesh.kill(id);
    if (AM.disposeChat) AM.disposeChat(id); // free the xterm + chat store too
    AM.toast('Closing ' + id);
    S.selectedId = null; renderMeshConfig();
  };

  // ---------- sync real state → graph ----------
  function defaultSpot(index) {
    // New nodes land inside the CURRENT camera view (world coords), so a spawn
    // never appears off-screen while the user is panned far away.
    const vw = (S.size.width || 900) / S.cam.z, vh = (S.size.height || 560) / S.cam.z;
    return {
      x: S.cam.x + vw * (0.16 + (index % 5) * 0.17),
      y: S.cam.y + vh * (0.22 + (Math.floor(index / 5) % 3) * 0.26),
    };
  }
  function syncNodes() {
    const agents = folderAgents();
    const saved = loadPos();
    const seen = {};
    agents.forEach((a, index) => {
      seen[a.id] = 1;
      const micro = AM.microStatus(a.id);
      const status = statusOf(a.id);
      let n = S.nodes[a.id];
      if (!n) {
        const spot = (saved[a.id] && typeof saved[a.id].x === 'number') ? saved[a.id] : defaultSpot(index);
        n = S.nodes[a.id] = {
          id: a.id, model: a.agentType, status: status, task: micro.text,
          x: spot.x, y: spot.y, element: null,
          _head: a.role === 'head', _meta: metaOf(a.id),
          _tier: AM.roleTier(a), _kids: childrenOf(a.id).length,
        };
        n.element = buildNodeEl(n);
        layer.appendChild(n.element);
        if (S.initialized) placeNode(n);
        if (a.id === S.justSpawned && !S.reduced) {
          n.element.classList.add('spawned');
          setTimeout(() => n.element.classList.remove('spawned'), 460);
        }
      } else {
        const head = a.role === 'head', meta = metaOf(a.id);
        // Tier/children changes (setRole, setParent) rebuild the card so branding
        // classes and badges stay in sync — not just the meta text.
        const tier = AM.roleTier(a), kids = childrenOf(a.id).length;
        if (n._head !== head || n.model !== a.agentType || n._tier !== tier || n._kids !== kids) {
          n._head = head; n.model = a.agentType; n._tier = tier; n._kids = kids;
          const fresh = buildNodeEl(n);
          n.element.replaceWith(fresh); n.element = fresh; placeNode(n);
        }
        if (n.status !== status) {
          n.status = status;
          const dot = n.element.querySelector('.graph-status');
          if (dot) dot.className = 'graph-status ' + status;
        }
        if (n.task !== micro.text) {
          n.task = micro.text;
          const t = n.element.querySelector('.graph-task');
          if (t) t.textContent = micro.text;
        }
        if (n._meta !== meta) {
          n._meta = meta;
          const m = n.element.querySelector('.graph-node-meta');
          if (m) m.textContent = meta;
        }
        const ml = modelLine(a.id);
        if (n._modelLine !== ml) {
          n._modelLine = ml;
          const me = n.element.querySelector('.graph-model');
          if (me) me.textContent = ml;
        }
      }
    });
    Object.keys(S.nodes).forEach((id) => {
      if (!seen[id]) {
        const n = S.nodes[id];
        if (n.element.parentNode) n.element.parentNode.removeChild(n.element);
        delete S.nodes[id];
        if (S.selectedId === id) { S.selectedId = null; renderMeshConfig(); }
      }
    });
    S.justSpawned = null;
    refreshChrome();
  }
  function syncWires() {
    const prevEdges = {};
    S.connections.forEach((c) => { prevEdges[c.source + '>' + c.target] = c; });
    const freshTargets = [];
    S.connections = (AM.state.wires || [])
      .filter((w) => S.nodes[w.from] && S.nodes[w.to])
      .map((w) => {
        const old = prevEdges[w.from + '>' + w.to];
        if (old) { delete prevEdges[w.from + '>' + w.to]; return old; } // keeps createdAt + particle phases + cached path
        freshTargets.push(w.to);
        return { source: w.from, target: w.to, createdAt: S.reduced ? 0 : performance.now(), dots: null };
      });
    // Whatever is left was removed — snapshot the curve so it fades out.
    Object.keys(prevEdges).forEach((key) => {
      const e = prevEdges[key];
      if (S.reduced || !S.nodes[e.source] || !S.nodes[e.target]) return;
      S.dying.push({
        c: curveOf(e.source, e.target),
        head: !!(paneOf(e.source) && paneOf(e.source).role === 'head'),
        diedAt: performance.now(),
      });
      if (S.dying.length > 20) S.dying.shift();
    });
    if (S.initialized) freshTargets.forEach((id) => pulseInput(id));
    // Wiring changed → the node meta ("Independent" vs "Wired · …") may change too.
    nodesList().forEach((n) => {
      const meta = metaOf(n.id);
      if (n._meta !== meta) {
        n._meta = meta;
        const m = n.element.querySelector('.graph-node-meta');
        if (m) m.textContent = meta;
      }
    });
    refreshChrome();
    renderMeshConfig();
    redraw();
  }
  function pulseInput(id) {
    const n = S.nodes[id]; if (!n) return;
    const port = n.element.querySelector('.graph-port.input');
    if (!port) return;
    port.classList.add('connect-pulse');
    setTimeout(() => port.classList.remove('connect-pulse'), 280);
  }
  function updateCapacity(count) {
    const narrow = matchMedia('(max-width:760px)').matches;
    const perRow = narrow ? 2 : 5;
    const extraRows = Math.max(0, Math.ceil((count - 6) / perRow));
    const base = narrow ? 480 : 600, ceiling = narrow ? 840 : 1040;
    // Cap to the visible viewport: the infinite canvas pans/zooms to reach any
    // number of nodes, so growing it below the fold only buries the overlay
    // controls (zoom cluster, hint). Fit = canvas-top → window bottom.
    const fit = Math.max(360, Math.round(window.innerHeight - root.getBoundingClientRect().top - 16));
    root.style.minHeight = Math.min(ceiling, base + extraRows * (narrow ? 115 : 130), fit) + 'px';
  }
  function refreshChrome() {
    const list = nodesList();
    const open = openMeshOn();
    list.forEach((n) => {
      // Open mesh: everyone can talk, so nobody renders as dashed/"unwired"
      // and both ports read as live.
      const incoming = open || S.connections.some((e) => e.target === n.id);
      const outgoing = open || S.connections.some((e) => e.source === n.id);
      n.element.classList.toggle('unwired', !(incoming || outgoing));
      n.element.querySelector('.graph-port.input').classList.toggle('connected', incoming);
      n.element.querySelector('.graph-port.output').classList.toggle('connected', outgoing);
    });
    updateCapacity(list.length);
    el('meshEmpty').hidden = list.length !== 0;
    updateMetrics();
  }

  // ---------- gestures ----------
  // Pointer position in WORLD coords (drag math, guides, and magnet distances
  // all live in world space alongside the nodes).
  function pointerPoint(e) {
    const rect = root.getBoundingClientRect();
    return toWorld(e.clientX - rect.left, e.clientY - rect.top);
  }
  function setMagnet(id) {
    if (S.magnet === id) return;
    layer.querySelectorAll('.graph-port.input').forEach((p) => p.classList.remove('magnet'));
    S.magnet = id;
    if (id && S.nodes[id]) S.nodes[id].element.querySelector('.graph-port.input').classList.add('magnet');
  }
  function nearestTarget(point, source) {
    let closest = null, distance = 40 / S.cam.z; // ~constant screen-px snap radius
    nodesList().forEach((n) => {
      if (n.id === source) return;
      const t = endpoint(n.id, 'input');
      const v = Math.hypot(point.x - t.x, point.y - t.y);
      if (v < distance) { distance = v; closest = n.id; }
    });
    return closest;
  }
  function clearConnectMode() {
    setMagnet(null);
    S.guide = null; S.keyboardSource = null;
    root.classList.remove('connecting');
    layer.querySelectorAll('.graph-node').forEach((n) => n.classList.remove('source-node'));
    layer.querySelectorAll('.graph-port.output').forEach((p) => p.classList.remove('is-source'));
    el('meshHint').textContent = HINT_DEFAULT;
    redraw();
  }
  function requestConnect(source, target) {
    if (!source || !target || source === target) return;
    if (connectionExists(source, target)) { AM.toast(source + ' → ' + target + ' already exists'); return; }
    mesh.addWire(source, target); // wires:update syncs graph + chatlens briefs the endpoints
    AM.toast(source + ' → ' + target + ' connected live');
  }

  root.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    const port = e.target.closest('.graph-port');
    const nodeElement = e.target.closest('.graph-node');
    if (!nodeElement) {
      // Empty space: pan the infinite canvas. Overlaid UI (inspector, zoom
      // controls, buttons) keeps its own pointer behavior.
      if (e.target.closest('.mesh-config, .mesh-context, .mesh-zoom, button, select, input')) return;
      e.preventDefault();
      S.drag = { type: 'pan', pointerId: e.pointerId, camX: S.cam.x, camY: S.cam.y, sx: e.clientX, sy: e.clientY, moved: false };
      root.classList.add('panning');
      root.setPointerCapture(e.pointerId);
      return;
    }
    const node = S.nodes[nodeElement.dataset.meshNode];
    if (!node) return;
    const point = pointerPoint(e);
    if (port) {
      if (!port.classList.contains('output')) return;
      e.preventDefault();
      S.drag = { type: 'connect', source: node.id, pointerId: e.pointerId, startX: point.x, startY: point.y, moved: false };
      S.guide = point;
      nodeElement.classList.add('source-node');
      port.classList.add('is-source');
      root.classList.add('connecting');
      root.setPointerCapture(e.pointerId);
      redraw();
      return;
    }
    e.preventDefault();
    S.drag = { type: 'node', id: node.id, pointerId: e.pointerId, offsetX: point.x - node.x, offsetY: point.y - node.y, moved: false };
    nodeElement.classList.add('dragging');
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => {
    const drag = S.drag; if (!drag) return;
    if (drag.type === 'pan') {
      S.cam.x = drag.camX - (e.clientX - drag.sx) / S.cam.z;
      S.cam.y = drag.camY - (e.clientY - drag.sy) / S.cam.z;
      if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
      schedulePan(); // one camera apply per frame, not per pointer event
      return;
    }
    const point = pointerPoint(e);
    // Tap thresholds are screen-feel: divide by zoom so they stay ~constant px.
    if (drag.type === 'node') {
      const node = S.nodes[drag.id]; if (!node) return;
      const nx = point.x - drag.offsetX, ny = point.y - drag.offsetY;
      if (!drag.moved && (Math.abs(nx - node.x) > 3 / S.cam.z || Math.abs(ny - node.y) > 3 / S.cam.z)) drag.moved = true;
      node.x = nx; node.y = ny;
      placeNode(node);
      redraw();
      return;
    }
    S.guide = point;
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4 / S.cam.z) drag.moved = true;
    setMagnet(nearestTarget(point, drag.source));
    redraw();
  });
  function finishPointer(e) {
    const drag = S.drag; if (!drag) return;
    if (drag.type === 'pan') {
      if (_panRaf) { cancelAnimationFrame(_panRaf); _panRaf = 0; }
      applyCamera(); // flush the final camera position
      root.classList.remove('panning');
      scheduleCamSave();
      S.drag = null;
      try { root.releasePointerCapture(e.pointerId); } catch (err) {}
      return;
    }
    if (drag.type === 'node') {
      const node = S.nodes[drag.id];
      if (node) {
        node.element.classList.remove('dragging');
        savePos();
        if (!drag.moved) {
          // Manual double-click detection: pointer capture redirects the DOM
          // click/dblclick away from the node, so we can't use those events. Two
          // quick no-move taps on the SAME node within 350ms = double-click →
          // open the Mesh Inspector. A single tap is drag-only (no panel).
          const now = performance.now();
          if (S.lastTap && S.lastTap.id === drag.id && now - S.lastTap.at < 350) {
            S.lastTap = null;
            selectNode(drag.id);
          } else {
            S.lastTap = { id: drag.id, at: now };
          }
        }
      }
    } else {
      // Pointer capture retargets the DOM click to root, so the click handler's
      // output-port branch never fires for a mouse press — handle the "tap an
      // output port" case HERE (same pointer-flow lesson as the dblclick fix).
      S.suppressClick = false;
      const tapped = !drag.moved && !S.magnet;
      if (S.magnet) requestConnect(drag.source, S.magnet);
      clearConnectMode();
      if (tapped) {
        S.keyboardSource = drag.source;
        const node = S.nodes[drag.source];
        if (node && node.element) {
          node.element.classList.add('source-node');
          const port = node.element.querySelector('.graph-port.output');
          if (port) port.classList.add('is-source');
        }
        root.classList.add('connecting');
        el('meshHint').textContent = 'Select another node input to connect from ' + drag.source;
      }
    }
    S.drag = null;
    try { root.releasePointerCapture(e.pointerId); } catch (err) {}
    redraw();
  }
  root.addEventListener('pointerup', finishPointer);
  root.addEventListener('pointercancel', finishPointer);

  // Wheel = zoom to cursor (trackpad pinch arrives as wheel+ctrlKey with finer
  // deltas — give it a stronger factor so pinch feels 1:1).
  root.addEventListener('wheel', (e) => {
    if (e.target.closest('.mesh-config')) return; // inspector scrolls its own content
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.0045 : 0.0012));
    setZoom(S.cam.z * factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  // click alternative: output → input
  root.addEventListener('click', (e) => {
    const port = e.target.closest('.graph-port');
    if (!port) return;
    if (S.suppressClick) { S.suppressClick = false; return; }
    e.stopPropagation();
    const id = port.closest('.graph-node').dataset.meshNode;
    if (port.classList.contains('output')) {
      clearConnectMode();
      S.keyboardSource = id;
      port.classList.add('is-source');
      port.closest('.graph-node').classList.add('source-node');
      root.classList.add('connecting');
      el('meshHint').textContent = 'Select another node input to connect from ' + id;
    } else if (S.keyboardSource && S.keyboardSource !== id) {
      const source = S.keyboardSource;
      requestConnect(source, id);
      clearConnectMode();
    }
  }, true);

  // ---------- traffic + layout ----------
  function trafficSignal(from, to) {
    // Prune cooled-off heat keys. heatOf() only cleans keys it reads, and the
    // ambient-link pass (which reads virtual-pair keys) is skipped above 12
    // nodes — so without this those keys would linger. Bus messages are the only
    // caller, so this sweep is cheap.
    const t0 = performance.now();
    for (const k in S.hot) { if (t0 - S.hot[k] > 4000) delete S.hot[k]; }
    const exists = S.connections.some((e) => e.source === from && e.target === to);
    // Open mesh: traffic can run between pairs with no drawn wire — animate it
    // along a synthesized curve instead of dropping the signal.
    const virtual = !exists && openMeshOn() && S.nodes[from] && S.nodes[to];
    if (!exists && !virtual) return;
    S.hot[from + '>' + to] = performance.now(); // wire runs hot, then cools (~1s)
    S.traffic.push({ source: from, target: to, virtual, started: performance.now(), duration: 820 });
    const label = el('meshTrafficLabel');
    label.textContent = from + ' → ' + to + ' now';
    setTimeout(() => { if (label.textContent === from + ' → ' + to + ' now') label.textContent = 'Bus traffic live'; }, 980);
    redraw();
  }
  // Forest layout (AM-FEAT-005): independent roots across the top, descendants
  // on deeper rows beneath their subtree. No single global HEAD assumption.
  // Infinite canvas: FIXED world spacing per node — the layout never cramps no
  // matter how many terminals there are; fitView() then frames the whole thing.
  function centerMesh() {
    if (!S.initialized) resizeCanvas();
    const agents = folderAgents();
    const roots = agents.filter((a) => !a.parentId || !S.nodes[a.parentId]);
    const depthRows = [];
    const place = (list, depth) => {
      if (!list.length) return;
      (depthRows[depth] = depthRows[depth] || []).push(...list.map((a) => a.id));
      list.forEach((a) => place(agents.filter((x) => x.parentId === a.id), depth + 1));
    };
    place(roots, 0);
    // Wide generations wrap into sub-rows of 10 so a 30-terminal folder lays
    // out as a readable grid instead of a 7000px-wide strip.
    const SPACING_X = 236, SPACING_Y = 195, SUBROW_Y = 160, WRAP = 10;
    let yCursor = 0;
    depthRows.forEach((ids) => {
      const rows = Math.ceil(ids.length / WRAP) || 1;
      ids.forEach((id, i) => {
        const n = S.nodes[id]; if (!n) return;
        const r = Math.floor(i / WRAP);
        const inRow = r === rows - 1 ? ids.length - r * WRAP : WRAP;
        n.x = ((i % WRAP) - (inRow - 1) / 2) * SPACING_X;
        n.y = yCursor + r * SUBROW_Y;
        placeNode(n);
      });
      yCursor += (rows - 1) * SUBROW_Y + SPACING_Y;
    });
    savePos();
    fitView();
    AM.toast('Terminals auto-arranged');
  }
  // Frame every node in the viewport (zoom-to-fit).
  function fitView() {
    const list = nodesList();
    if (!list.length || !S.size.width) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach((n) => {
      const hw = (n.element && n.element.offsetWidth / 2) || 92, hh = 62;
      minX = Math.min(minX, n.x - hw); maxX = Math.max(maxX, n.x + hw);
      minY = Math.min(minY, n.y - hh); maxY = Math.max(maxY, n.y + hh);
    });
    const pad = 56;
    const bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
    const z = Math.max(ZOOM_MIN, Math.min(1.35, Math.min(S.size.width / bw, S.size.height / bh)));
    S.cam.z = z;
    S.cam.x = (minX + maxX) / 2 - S.size.width / (2 * z);
    S.cam.y = (minY + maxY) / 2 - S.size.height / (2 * z);
    applyCamera();
    scheduleCamSave();
  }

  function activate() {
    resizeCanvas();
    syncNodes();
    syncWires();
    // First open of a folder with no saved camera: frame all terminals once.
    if (S._needsFit && nodesList().length) { S._needsFit = false; fitView(); }
    S.running = true;
    redraw();
  }
  function renderMesh() { updateMetrics(); updateGuardPanel(); if (inMesh()) activate(); }
  AM.renderMesh = renderMesh;
  AM.meshFocus = (id) => { S.justSpawned = id; };

  // ---------- guardrails controls ----------
  el('capSet').onclick = () => {
    const raw = el('capInput').value.trim();
    const n = raw === '' ? 0 : parseInt(raw, 10);
    mesh.setMaxExchanges(Number.isNaN(n) ? 0 : n);
    AM.toast(n > 0 ? ('Exchange cap set to ' + n) : 'Exchange cap removed (unlimited)');
  };
  el('capInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('capSet').click(); });
  el('budgetSet').onclick = async () => {
    const n = Math.max(0, parseFloat(el('budgetInput').value) || 0);
    if (mesh.autopilotSet) await mesh.autopilotSet({ budgetCap: n });
    AM.toast(n > 0 ? 'Budget cap $' + n + ' (est.) — pauses the mesh when exceeded' : 'Budget cap off');
  };
  el('budgetInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('budgetSet').click(); });
  function syncOpenMeshSwitch() {
    const on = openMeshOn();
    const sw = el('openMeshSwitch');
    sw.classList.toggle('off', !on);
    sw.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  el('openMeshSwitch').onclick = async () => {
    const next = !openMeshOn();
    if (mesh.settingsSet) await mesh.settingsSet({ openMesh: next });
    AM.toast(next
      ? 'Open mesh ON — every terminal can send & receive freely'
      : 'Open mesh OFF — strict directed wiring restored');
  };
  let stopArmed = false, stopTimer;
  el('stopAll').onclick = function () {
    if (!stopArmed) {
      stopArmed = true; this.textContent = 'Confirm — stop all'; this.classList.add('danger');
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => { stopArmed = false; this.textContent = 'Stop all agents'; this.classList.remove('danger'); }, 3000);
      return;
    }
    mesh.stopAll(); stopArmed = false; this.textContent = 'Stop all agents'; this.classList.remove('danger');
    AM.toast('Stop signal sent to all agents');
  };
  el('meshCenter').onclick = centerMesh;
  el('meshResetView').onclick = () => { fitView(); AM.toast('View reset — all terminals framed'); };
  el('addMeshAgent').onclick = function () { AM.spawnMenu(this); };
  el('meshZoomIn').onclick = () => setZoom(S.cam.z * 1.25);
  el('meshZoomOut').onclick = () => setZoom(S.cam.z / 1.25);
  el('meshZoomFit').onclick = fitView;

  // ---------- subscriptions ----------
  AM.on('view', (v) => { if (v === 'mesh') renderMesh(); else { S.running = false; } });
  AM.on('panes', () => { if (inMesh()) { syncNodes(); syncWires(); renderMeshConfig(); } updateMetrics(); });
  AM.on('wires', () => { if (inMesh()) syncWires(); else updateMetrics(); });
  AM.on('snapshot', () => { if (inMesh()) syncNodes(); });
  AM.on('selectFolder', () => {
    layer.replaceChildren(); S.nodes = {}; S.connections = []; S.selectedId = null;
    S.traffic = []; S.dying = []; S.ripples = []; S.hot = {}; // FX state is per-folder
    loadCam(); // camera (pan/zoom) is saved per folder too
    renderMeshConfig();
    if (inMesh()) renderMesh(); else updateMetrics();
  });
  AM.on('guard', () => { updateMetrics(); updateGuardPanel(); });
  AM.on('guardPaused', updateGuardPanel);
  AM.on('settings', () => {
    syncOpenMeshSwitch();
    if (inMesh()) { syncNodes(); refreshChrome(); renderMeshConfig(); } else updateMetrics();
  });
  syncOpenMeshSwitch();
  loadCam(); // initial folder's saved camera (or 0,0 @ 100%)
  AM.on('cost', () => { if (inMesh()) updateMetrics(); });
  AM.on('agentinfo', () => { if (inMesh()) syncNodes(); });
  AM.on('view', (v) => { if (v === 'mesh' && AM.refreshAgentInfo) AM.refreshAgentInfo(); });
  AM.on('busmsg', (m) => { if (inMesh() && m.from && m.to) trafficSignal(m.from, m.to); });
  // GC saved node positions for folders that no longer exist (e.g. removed).
  AM.on('folders', (folders) => {
    if (!folders || !folders.length) return; // ignore a transient empty list
    try {
      const alive = {};
      folders.forEach((f) => { alive[f.id] = 1; });
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        const m = /^am-meshpos[23]-(.+)$/.exec(k || '');
        if (m && !alive[m[1]]) localStorage.removeItem(k);
      }
    } catch (_) {}
  });
  new ResizeObserver(() => { if (inMesh()) resizeCanvas(); }).observe(root);
  motionQuery.addEventListener && motionQuery.addEventListener('change', (e) => {
    S.reduced = e.matches;
    if (e.matches && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    if (!e.matches && inMesh()) S.running = true;
    redraw();
  });
})();
