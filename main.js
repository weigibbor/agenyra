'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { PtyManager } = require('./main/pty');
const { Router } = require('./main/router');
const { Coordinator } = require('./main/coordinator');
const { WorktreeManager } = require('./main/worktree');
const { Guard } = require('./main/guard');
const { Bus } = require('./main/bus');
const { MissionStore } = require('./main/missions');
const { RunLog } = require('./main/runlog');
const { AutopilotEngine } = require('./main/autopilot-engine');
const os = require('os');
const { CostTracker, mungeCwd } = require('./main/cost');
const { SessionStore } = require('./main/session');
const { writeFileAtomic } = require('./main/atomic');

let win = null;
let pty, router, coordinator, guard, bus, missions, runlog, engine, cost, session;

// Last-resort crash guards: a single throw from a PTY write, a bus handler, or a
// stray rejection must NOT take down the whole app (and every live agent with
// it). Log and keep running; genuine boot failures are handled separately below.
process.on('uncaughtException', (err) => {
  console.error('[agenyra] uncaughtException:', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[agenyra] unhandledRejection:', (reason && reason.stack) || reason);
});
// Session ledger (Phase 5): survives crashes/quits; explicit kill removes an
// entry (the user closed that agent on purpose), exit keeps it (respawnable).
const paneSpecs = new Map(); // paneId -> spec

// ---- Folder registry --------------------------------------------------------
// Each project folder is its own git repo with its own WorktreeManager and its
// own HEAD. An agent (pane) belongs to exactly one folder; that folder decides
// where the pane runs and, for workers, which repo gets the isolated worktree.
const folders = new Map(); // folderId -> { id, name, repo, wtm, isGit, exists }
const paneFolder = new Map(); // paneId  -> folderId
let folderSeq = 0;
const startedAt = Date.now();

// Per-session bus secret: injected into every pane (MESH_TOKEN) and required on
// every bus request. Requiring a custom header forces a CORS preflight that no
// cross-origin web page can satisfy, so a malicious site the tester visits can't
// forge requests into a live agent terminal.
const busToken = crypto.randomBytes(32).toString('hex');

// Packaged builds run from a read-only bundle (app.asar / Program Files), so
// persistent state must live under the OS per-user data dir. In dev we keep it
// in the repo so the demo `.state` and existing tooling keep working unchanged.
const STATE_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'state')
  : path.join(__dirname, '.state');
const FOLDERS_FILE = path.join(STATE_DIR, 'folders.json');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function makeFolder(repo, id) {
  const fid = id || `f${++folderSeq}`;
  const exists = fs.existsSync(repo);
  const wtm = new WorktreeManager(exists ? repo : null);
  const isGit = exists ? await wtm.init() : false;
  return { id: fid, name: path.basename(repo), repo, wtm, isGit, exists };
}

function folderInfo(f) {
  return {
    id: f.id,
    name: f.name,
    repo: f.repo,
    isGit: f.isGit,
    exists: f.exists,
    baseBranch: f.wtm ? f.wtm.baseBranch : 'HEAD',
    worktrees: f.wtm ? f.wtm.list() : [],
  };
}
function listFolders() {
  return [...folders.values()].map(folderInfo);
}
function folderForPane(id) {
  const fid = paneFolder.get(id);
  return fid ? folders.get(fid) : null;
}

function specFor(id) {
  const pane = pty.get(id);
  if (!pane) return paneSpecs.get(id) || null;
  const folder = folders.get(pane.folderId);
  const wt = folder && folder.wtm ? folder.wtm.get(id) : null;
  return {
    id: pane.id,
    agentType: pane.agentType,
    role: pane.role,
    folderId: pane.folderId,
    parentId: pane.parentId,
    activationPolicy: pane.activationPolicy,
    effort: pane.effort || null,
    branch: wt ? wt.branch : null,
    worktreePath: wt ? wt.path : null,
  };
}
function saveSession() {
  if (session) session.savePanes([...paneSpecs.values()]);
}
function updateSpec(id) {
  const spec = specFor(id);
  if (spec) { paneSpecs.set(id, spec); saveSession(); }
}

// Recreate one pane from a saved spec: adopt (never destroy) its worktree,
// then spawn the PTY with the same identity. The renderer relaunches the CLI.
async function restorePane(spec) {
  if (!spec || pty.has(spec.id)) return null;
  const folder = folders.get(spec.folderId);
  if (!folder || !folder.exists) return null;
  let cwd = folder.repo;
  if (folder.isGit && spec.branch) {
    let wt = null;
    try { wt = await folder.wtm.adopt(spec.id); } catch (_) { wt = null; }
    if (!wt) { try { wt = await folder.wtm.create(spec.id); } catch (_) {} }
    if (wt) cwd = wt.path;
  }
  // `claude --continue` only works when a prior conversation exists for this
  // exact cwd — interactive claude EXITS otherwise (drill-verified), dumping
  // the relaunch commands into the shell. Check for a real transcript first.
  let canContinue = false;
  if (spec.agentType === 'claude') {
    try {
      const tdir = path.join(os.homedir(), '.claude', 'projects', mungeCwd(cwd));
      canContinue = fs.existsSync(tdir) && fs.readdirSync(tdir).some((n) => n.endsWith('.jsonl'));
    } catch (_) { canContinue = false; }
  }
  const rec = pty.create(spec.id, {
    agentType: spec.agentType,
    role: spec.role,
    folderId: spec.folderId,
    parentId: spec.parentId,
    activationPolicy: spec.activationPolicy,
    effort: spec.effort || null,
    restored: true,
    canContinue,
    cwd,
  });
  paneFolder.set(spec.id, spec.folderId);
  updateSpec(spec.id);
  return rec;
}

async function restoreSession() {
  const specs = session.loadPanes();
  let restored = 0;
  for (const spec of specs) {
    paneSpecs.set(spec.id, spec); // keep even if restore fails (respawnable later)
    try { if (await restorePane(spec)) restored++; } catch (e) {
      console.log(`[session] restore ${spec.id} failed: ${e.message}`);
    }
  }
  router.loadWires(session.loadWires());
  if (restored) runlog.add('session.restored', { data: { agents: restored, wires: router.listWires().length } });
  console.log(`[session] restored ${restored}/${specs.length} agents, ${router.listWires().length} wires`);
}

function persistFolders() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const data = [...folders.values()].map((f) => ({ id: f.id, name: f.name, repo: f.repo }));
    writeFileAtomic(FOLDERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log(`[agenyra] persistFolders failed: ${e.message}`);
  }
}
async function loadFolders() {
  try {
    if (!fs.existsSync(FOLDERS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8'));
    let maxSeq = 0;
    for (const it of Array.isArray(data) ? data : []) {
      if (!it || !it.repo) continue;
      const folder = await makeFolder(it.repo, it.id);
      folders.set(folder.id, folder);
      const n = parseInt(String(it.id).replace(/^f/, ''), 10);
      if (!Number.isNaN(n)) maxSeq = Math.max(maxSeq, n);
    }
    folderSeq = Math.max(folderSeq, maxSeq);
  } catch (e) {
    console.log(`[agenyra] loadFolders failed: ${e.message}`);
  }
}

async function boot() {
  // bin/ ships as an unpacked resource in packaged builds (electron-builder
  // extraResources → resources/bin); in dev it sits alongside the source.
  const binDir = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, 'bin');
  pty = new PtyManager({ busPort: 0, binDir, token: busToken });
  guard = new Guard();
  router = new Router(pty, guard);
  coordinator = new Coordinator();
  await loadFolders();
  // Phase 4B: mission queue + persistent run log + the autopilot engine.
  missions = new MissionStore(STATE_DIR);
  runlog = new RunLog(STATE_DIR);
  engine = new AutopilotEngine({ stateDir: STATE_DIR, missions, runlog, pty, router, guard, folders });
  cost = new CostTracker({ pty, guard, runlog, getBudgetCap: () => engine.getState().budgetCap });
  session = new SessionStore(STATE_DIR);
  bus = new Bus({ router, coordinator, ptyManager: pty, engine, token: busToken });

  const port = await bus.start();
  pty.setBusPort(port);
  const bootSettings = loadSettings();
  pty.setDefaultShell(bootSettings.defaultShell);
  router.openMesh = !!bootSettings.openMesh;
  await restoreSession(); // needs the bus port (MESH_PORT env) — after start
  router.on('wires', (w) => session.saveWires(w));

  // Forward backend events to the renderer.
  pty.on('data', (d) => send('pty:data', d));
  pty.on('exit', (d) => {
    // Keep the paneFolder/worktree mapping after an exit so a crashed worker's
    // branch can still be inspected or merged; an explicit kill is what tears
    // the worktree down.
    closeFsWatcher(d.id);
    send('pty:exit', d);
    send('panes:update', pty.list());
  });
  router.on('message', (m) => send('bus:message', m));
  router.on('wires', (w) => send('wires:update', w));
  coordinator.on('change', (s) => send('coordinator:state', s));
  coordinator.on('announce', (a) => send('bus:announce', a));
  guard.on('change', (s) => send('guard:state', s));
  guard.on('paused', (reason) => send('guard:paused', reason));
  missions.on('change', (list) => send('missions:update', list));
  runlog.on('event', (ev) => send('runlog:event', ev));
  engine.on('state', (s) => send('autopilot:state', s));
  cost.on('update', (s) => send('cost:update', s));
  engine.on('officerCost', ({ usd, tokens }) => cost.addFixed('officer', usd, tokens));

  console.log(`[agenyra] bus listening on http://127.0.0.1:${port}`);
}

function createWindow() {
  // Packaged builds get the exe/dock icon from electron-builder; this covers the
  // dev taskbar (build/icon.png is buildResources, absent from the asar).
  const devIcon = path.join(__dirname, 'build', 'icon.png');
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Agenyra',
    ...(fs.existsSync(devIcon) ? { icon: devIcon } : {}),
    frame: false, // custom title bar (matches the design); controls wired via IPC below
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Navigation lockdown: the app renders untrusted agent output, and the preload
  // exposes a powerful window.mesh bridge. Never let the top frame navigate away
  // to (or open) a remote origin that would inherit that bridge — open external
  // links in the real browser instead.
  const openExternal = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {}); };
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) { e.preventDefault(); openExternal(url); }
  });
  win.webContents.on('will-redirect', (e, url) => { e.preventDefault(); openExternal(url); });

  // Surface renderer console output (incl. uncaught errors) in the main log,
  // so we can debug the UI without opening DevTools. Handles both the legacy
  // positional signature and the newer event-object one.
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const msg = message !== undefined ? message : e && e.message;
    const src = sourceId !== undefined ? sourceId : e && e.sourceId;
    const ln = line !== undefined ? line : e && e.lineNumber;
    if (msg) console.log(`[renderer] ${msg}${src ? ` (${src}:${ln})` : ''}`);
  });
}

// ---- IPC: panes / pty ------------------------------------------------------
ipcMain.handle('pty:create', async (_e, { id, opts }) => {
  opts = opts || {};
  // Fail BEFORE the worktree side effect — pty.create would throw on a
  // duplicate id anyway, but by then an orphaned worktree would be on disk.
  if (pty.has(id)) throw new Error(`pane "${id}" already exists`);
  const folder = opts.folderId ? folders.get(opts.folderId) : null;
  let cwd = opts.cwd;
  let worktreeInfo = null;
  if (folder && folder.exists) {
    if (opts.role === 'head' || !folder.isGit) {
      // HEAD works in the repo root; a non-git folder has no worktrees at all.
      cwd = folder.repo;
    } else if (opts.worktree !== false) {
      // Workers get an isolated worktree so parallel edits never collide.
      try {
        worktreeInfo = await folder.wtm.create(id);
        cwd = worktreeInfo.path;
      } catch (e) {
        cwd = folder.repo;
        console.log(`[agenyra] worktree create failed for ${id}: ${e.message}`);
      }
    } else {
      cwd = folder.repo;
    }
  }
  const rec = pty.create(id, Object.assign({}, opts, { cwd }));
  if (folder) paneFolder.set(id, folder.id);
  updateSpec(id);
  send('panes:update', pty.list());
  return Object.assign({}, rec, { worktree: worktreeInfo, folderId: folder ? folder.id : null });
});
ipcMain.on('pty:input', (_e, { id, data }) => pty.write(id, data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => pty.resize(id, cols, rows));
ipcMain.on('pty:kill', async (_e, { id }) => {
  const folder = folderForPane(id);
  closeFsWatcher(id);
  pty.kill(id);
  if (cost) cost.forget(id); // fold its spend into the retired total, free per-agent maps
  paneFolder.delete(id);
  paneSpecs.delete(id); // explicit close = not restored next boot
  router.removeWiresFor(id); // else a future pane reusing this id inherits them
  saveSession();
  if (folder && folder.wtm && folder.wtm.get(id)) {
    try { await folder.wtm.remove(id); } catch (_) {} // leave dirty worktrees for the user
  }
  send('panes:update', pty.list());
});
ipcMain.on('pane:setRole', (_e, { id, role }) => {
  pty.setRole(id, role);
  updateSpec(id);
  send('panes:update', pty.list());
});
ipcMain.handle('pane:setParent', (_e, { id, parentId }) => {
  const res = pty.setParent(id, parentId);
  if (res.ok) { updateSpec(id); send('panes:update', pty.list()); }
  return res;
});
ipcMain.on('pane:setActivation', (_e, { id, policy }) => {
  pty.setActivation(id, policy);
  updateSpec(id);
  send('panes:update', pty.list());
});
ipcMain.on('pane:setEffort', (_e, { id, effort }) => {
  pty.setEffort(id, effort);
  updateSpec(id);
  send('panes:update', pty.list());
});
// Phase 5: the renderer confirms it relaunched a restored pane's CLI — clear
// the flag so a mere renderer reload never re-types the launch command into a
// session that is already running.
ipcMain.on('pane:launched', (_e, { id }) => {
  const pane = pty.get(id);
  if (pane && pane.restored) { pane.restored = false; send('panes:update', pty.list()); }
});
// Phase 5: bring a crashed/exited agent back with the same identity + worktree.
ipcMain.handle('pane:respawn', async (_e, { id }) => {
  if (pty.has(id)) return { ok: false, error: 'agent is still running' };
  const spec = paneSpecs.get(id);
  if (!spec) return { ok: false, error: 'no saved spec for ' + id };
  try {
    const rec = await restorePane(spec);
    if (!rec) return { ok: false, error: 'folder unavailable' };
    send('panes:update', pty.list());
    runlog.add('session.respawned', { folderId: spec.folderId, data: { agentId: id } });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on('wire:add', (_e, { from, to }) => router.addWire(from, to));
ipcMain.on('wire:remove', (_e, { from, to }) => router.removeWire(from, to));
ipcMain.handle('wires:list', () => router.listWires());
// The renderer may only ever speak as the human. The bus rejects forged
// 'human'/'autopilot' senders (bus.js) — the IPC path must enforce the same
// rule, or a compromised renderer could route as 'autopilot' past all wires.
ipcMain.handle('mesh:route', (_e, { from, to, message, submit }) => {
  if (from !== 'human') return { ok: false, error: 'renderer may only send as "human"' };
  return router.route(from, to, message, submit);
});
ipcMain.handle('coordinator:snapshot', () => coordinator.snapshot());
ipcMain.handle('panes:list', () => pty.list());
ipcMain.handle('task:add', (_e, { title, steps }) => coordinator.addTask(title, steps || []));
// busToken is handed to the (trusted, CSP-locked) renderer only so in-app tooling
// and QA can talk to the bus; an external page can't reach this IPC bridge.
ipcMain.handle('app:info', () => ({ busPort: bus ? bus.port : 0, busToken, cwd: process.cwd(), startedAt }));

// ---- IPC: folders (projects) -----------------------------------------------
ipcMain.handle('folder:add', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Add a project folder',
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const repo = res.filePaths[0];
  for (const f of folders.values()) {
    if (f.repo === repo) return { ok: true, folder: folderInfo(f), existed: true };
  }
  const folder = await makeFolder(repo);
  folders.set(folder.id, folder);
  persistFolders();
  send('folders:update', listFolders());
  return { ok: true, folder: folderInfo(folder) };
});
ipcMain.handle('folder:list', () => listFolders());
ipcMain.handle('folder:remove', (_e, { id }) => {
  for (const fid of paneFolder.values()) {
    if (fid === id) return { ok: false, error: 'folder still has active agents' };
  }
  folders.delete(id);
  persistFolders();
  send('folders:update', listFolders());
  return { ok: true };
});

// ---- IPC: worktrees (routed to the owning folder) --------------------------
ipcMain.handle('worktree:diff', async (_e, { id }) => {
  const f = folderForPane(id);
  if (!f || !f.wtm) return { error: `no folder for ${id}` };
  try { return await f.wtm.diff(id); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('worktree:merge', async (_e, { id }) => {
  const f = folderForPane(id);
  if (!f || !f.wtm) return { ok: false, error: `no folder for ${id}` };
  // Same per-folder mutex as the Autopilot engine — a human direct-merge must
  // never interleave with an officer/approve merge on the same repo.
  if (engine && engine.mergeLocks[f.id]) return { ok: false, error: 'a merge is already in progress for this folder' };
  if (engine) engine.mergeLocks[f.id] = true;
  try { return await f.wtm.merge(id); } catch (e) { return { ok: false, error: e.message }; }
  finally { if (engine) engine.mergeLocks[f.id] = false; }
});
ipcMain.handle('worktree:remove', async (_e, { id, force }) => {
  const f = folderForPane(id);
  if (!f || !f.wtm) return { ok: true, removed: false };
  try { return await f.wtm.remove(id, force); } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('worktree:list', () => {
  const out = [];
  for (const f of folders.values()) {
    if (!f.wtm) continue;
    for (const w of f.wtm.list()) out.push(Object.assign({ folderId: f.id }, w));
  }
  return out;
});

// ---- IPC: workbench file access (AM-FEAT-002) -------------------------------
// Read-only observability over an agent's working directory: file tree, file
// content, git changes, and a change watcher. Never writes; paths are jailed
// to the pane's cwd.
const { git } = require('./main/worktree');
const fsWatchers = new Map(); // paneId -> fs.FSWatcher
const SKIP_DIRS = new Set(['node_modules', '.git', '.state', 'dist', 'out', 'legacy']);

function paneCwd(id) {
  const pane = pty.get(id);
  return pane ? pane.cwd : null;
}
// Case-insensitive containment on Windows (C:\Users vs c:\users are the same dir).
function within(child, parent) {
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p + path.sep);
}
function safeJoin(root, rel) {
  const abs = path.resolve(root, String(rel || ''));
  const normRoot = path.resolve(root);
  if (!within(abs, normRoot)) return null;
  // Never expose git metadata: a write into .git/hooks/ would be arbitrary
  // code execution on the app's own next git operation.
  const parts = path.relative(normRoot, abs).split(path.sep);
  if (parts.some((seg) => seg.toLowerCase() === '.git')) return null;
  // Lexical containment is not enough — a symlink inside the jail could point
  // anywhere. Resolve the deepest EXISTING ancestor and require its real
  // location to still be inside the (real) root.
  try {
    const realRoot = fs.realpathSync(normRoot);
    let probe = abs;
    while (!fs.existsSync(probe)) {
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    const realProbe = fs.realpathSync(probe);
    const tail = path.relative(probe, abs);
    const realAbs = tail ? path.join(realProbe, tail) : realProbe;
    if (!within(realAbs, realRoot)) return null;
  } catch (_) { return null; }
  return abs;
}
function walkTree(root) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < 400) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      if (out.length >= 400) break;
      if (ent.name.startsWith('.') && ent.name !== '.gitignore') continue;
      const full = path.join(cur.dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name) && cur.depth < 5) stack.push({ dir: full, depth: cur.depth + 1 });
      } else if (ent.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  return out.sort();
}
ipcMain.handle('fs:tree', (_e, { id }) => {
  const cwd = paneCwd(id);
  if (!cwd) return { error: 'no pane' };
  return { root: cwd, files: walkTree(cwd) };
});
ipcMain.handle('fs:read', (_e, { id, path: rel }) => {
  const cwd = paneCwd(id);
  if (!cwd) return { error: 'no pane' };
  const abs = safeJoin(cwd, rel);
  if (!abs) return { error: 'bad path' };
  try {
    const stat = fs.statSync(abs);
    if (stat.size > 262144) return { error: 'file too large (256KB cap)', size: stat.size };
    const buf = fs.readFileSync(abs);
    if (buf.slice(0, 8192).includes(0)) return { binary: true };
    return { content: buf.toString('utf8') };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('fs:changes', async (_e, { id }) => {
  const cwd = paneCwd(id);
  if (!cwd) return { rows: [] };
  try {
    const out = await git(cwd, ['status', '--porcelain']);
    // real +/− line counts per file (untracked files have none → shown as "new")
    const stats = {};
    try {
      const numstat = await git(cwd, ['diff', 'HEAD', '--numstat']);
      numstat.split('\n').filter(Boolean).forEach((ln) => {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(ln);
        if (m) stats[m[3].replace(/"/g, '')] = m[1] === '-' ? 'bin' : '+' + m[1] + ' −' + m[2];
      });
    } catch (_) {}
    const rows = out.split('\n').filter(Boolean).map((ln) => {
      const p = ln.slice(3).trim().replace(/"/g, '');
      const state = ln.slice(0, 2).trim() || 'M';
      return { state, path: p, stat: stats[p] || (state === '??' ? 'new' : '') };
    });
    return { rows };
  } catch (_) { return { rows: [] }; }
});
// Phase 5.1: the ONLY write the workbench can do — save an edited file, jailed
// to the pane's cwd, size-capped, user-initiated from the editor's Save.
ipcMain.handle('fs:write', (_e, { id, path: rel, content }) => {
  const cwd = paneCwd(id);
  if (!cwd) return { ok: false, error: 'no pane' };
  const abs = safeJoin(cwd, rel);
  if (!abs) return { ok: false, error: 'bad path' };
  const text = String(content == null ? '' : content);
  if (text.length > 1048576) return { ok: false, error: 'file too large (1MB cap)' };
  try {
    fs.writeFileSync(abs, text);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:diff', async (_e, { id, path: rel }) => {
  const cwd = paneCwd(id);
  if (!cwd) return { patch: '' };
  try {
    const patch = await git(cwd, ['diff', 'HEAD', '--', rel]);
    return { patch };
  } catch (_) { return { patch: '' }; }
});
ipcMain.on('fs:watch', (_e, { id }) => {
  const cwd = paneCwd(id);
  if (!cwd || fsWatchers.has(id)) return;
  try {
    let timer = null;
    const pending = new Set();
    const watcher = fs.watch(cwd, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const rel = String(file).split(path.sep).join('/');
      if (rel.split('/').some((seg) => SKIP_DIRS.has(seg) || (seg.startsWith('.') && seg !== '.gitignore'))) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending]; pending.clear();
        send('fs:changed', { id, files });
      }, 150);
      watcher._debounce = timer; // tracked so closeFsWatcher can cancel a pending fire
    });
    // An async watcher failure (huge tree, network drive) emits 'error' —
    // unhandled it would crash the main process.
    watcher.on('error', (err) => {
      console.log(`[agenyra] fs watcher error for ${id}: ${err.message}`);
      closeFsWatcher(id);
    });
    fsWatchers.set(id, watcher);
  } catch (e) { console.log(`[agenyra] fs:watch failed for ${id}: ${e.message}`); }
});
function closeFsWatcher(id) {
  const w = fsWatchers.get(id);
  if (w) { try { clearTimeout(w._debounce); } catch (_) {} try { w.close(); } catch (_) {} fsWatchers.delete(id); }
}

// ---- IPC: autopilot missions (Phase 4B) -------------------------------------
ipcMain.handle('mission:add', (_e, { folderId, goal }) => engine.addMission(folderId, goal));
ipcMain.handle('mission:remove', (_e, { id }) => engine.removeMission(id));
ipcMain.handle('mission:list', (_e, { folderId } = {}) => engine.listMissions(folderId));
ipcMain.handle('mission:approve', (_e, { id }) => engine.approveMission(id));
ipcMain.handle('mission:requestChanges', (_e, { id, comment }) => engine.requestChanges(id, comment));
ipcMain.handle('mission:rollback', (_e, { id }) => engine.rollbackMission(id));
ipcMain.handle('mission:retry', (_e, { id }) => engine.retryMission(id));
ipcMain.handle('mission:cancel', (_e, { id }) => engine.cancelMission(id));
ipcMain.handle('autopilot:get', () => engine.getState());
ipcMain.handle('autopilot:set', (_e, patch) => engine.setState(patch || {}));
ipcMain.handle('runlog:list', (_e, opts) => runlog.list(opts || {}));
ipcMain.handle('digest:get', () => runlog.digest(engine.getState().lastSeenTs));
ipcMain.handle('digest:seen', () => engine.setState({ lastSeenTs: Date.now() }));
ipcMain.handle('cost:get', () => (cost ? cost.snapshot() : { perAgent: {}, totals: { known: false, tokens: 0, usd: 0 } }));

// ---- IPC: Code-view scratch terminal (VS Code-style, at the project root) ----
// A plain shell the USER drives to run commands — separate from any agent, one
// per folder, rooted at the repo root. Marked utility so it never shows as an agent.
ipcMain.handle('wbterm:ensure', (_e, { folderId, cols, rows }) => {
  const folder = folders.get(folderId);
  if (!folder || !folder.exists) return { ok: false, error: 'folder unavailable' };
  const id = 'wbterm-' + folderId;
  const cwd = folder.repo; // the project folder (repo root), like a VS Code terminal
  if (!pty.has(id)) {
    pty.create(id, { agentType: 'shell', utility: true, folderId, cwd, cols: cols || 80, rows: rows || 18 });
    paneFolder.set(id, folderId);
  }
  return { ok: true, id, cwd };
});

// ---- IPC: pasted-image attachments (composer screenshots) -------------------
// Saved to .state/attachments/ and referenced by ABSOLUTE path in the message —
// Claude Code reads image paths, so a pasted screenshot reaches the agent as a
// real file it can open. Kept out of the worktree so it never dirties git.
const ATTACH_DIR = path.join(STATE_DIR, 'attachments');
ipcMain.handle('attach:save', (_e, { dataUrl }) => {
  try {
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!m) return { ok: false, error: 'not an image' };
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 12 * 1024 * 1024) return { ok: false, error: 'image too large (12MB cap)' };
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const name = 'paste-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext;
    const abs = path.join(ATTACH_DIR, name);
    fs.writeFileSync(abs, buf);
    return { ok: true, path: abs, name, bytes: buf.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: app settings (Phase 5) --------------------------------------------
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  launch: {
    claude: 'claude --dangerously-skip-permissions',
    codex: 'codex --dangerously-bypass-approvals-and-sandbox',
    grok: 'grok --always-approve',
    aider: 'aider --yes-always',
  },
  // Per-preset reasoning-effort flag template ({level} is substituted). Verified:
  // claude `--effort` (low/medium/high/xhigh/max), grok `--effort` (none/minimal/
  // low/medium/high/xhigh/max), codex `-c model_reasoning_effort` (minimal/low/
  // medium/high). Empty = no inject.
  effortFlags: {
    claude: '--effort {level}',
    grok: '--effort {level}',
    codex: '-c model_reasoning_effort="{level}"',
    aider: '',
  },
  defaultEffort: 'high',
  defaultShell: '', // empty = platform default (powershell.exe / $SHELL)
  themeDefault: 'dark',
  defaultActivation: 'manual',
  // Open mesh: agents in the same folder can send/receive freely, no wires
  // needed. OFF restores strict directed wiring. Deep-merge means older
  // settings.json files without the key default to ON.
  openMesh: true,
};
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      // Deep-merge the per-preset maps so newly-added presets (e.g. grok) still
      // get their defaults even when an older settings.json is on disk.
      return Object.assign({}, DEFAULT_SETTINGS, s, {
        launch: Object.assign({}, DEFAULT_SETTINGS.launch, s.launch || {}),
        effortFlags: Object.assign({}, DEFAULT_SETTINGS.effortFlags, s.effortFlags || {}),
      });
    }
  } catch (e) { console.log(`[settings] load failed: ${e.message}`); }
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const merged = Object.assign(loadSettings(), patch || {});
  if (patch && patch.launch) merged.launch = Object.assign(loadSettings().launch, patch.launch);
  if (patch && patch.effortFlags) merged.effortFlags = Object.assign(loadSettings().effortFlags, patch.effortFlags);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeFileAtomic(SETTINGS_FILE, JSON.stringify(merged, null, 2)); // crash-safe like every other state file
  } catch (e) { return { ok: false, error: e.message }; }
  if (pty && merged.defaultShell !== undefined) pty.setDefaultShell(merged.defaultShell);
  if (router) router.openMesh = !!merged.openMesh;
  send('settings:update', merged);
  return merged;
});

// ---- IPC: guardrails -------------------------------------------------------
ipcMain.on('agents:stop', () => {
  pty.interruptAll();
  guard.pause('stopped by user');
  // The panic button must be sticky: also switch Autopilot OFF, or the engine
  // would re-dispatch queued missions the moment the guard is resumed.
  if (engine && engine.getState().autopilotOn) engine.setState({ autopilotOn: false });
});
ipcMain.on('guard:pause', (_e, { reason }) => guard.pause(reason || 'paused'));
ipcMain.on('guard:setMax', (_e, { n }) => guard.setMax(n));
ipcMain.on('guard:resume', () => guard.resume());
ipcMain.on('guard:reset', () => guard.reset());
ipcMain.handle('guard:stats', () => guard.stats());

// ---- IPC: custom title-bar window controls (frameless window) --------------
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win && win.close());

// Single-instance lock: a second launch would spin up a second bus and race the
// SAME .state/*.json files (last-writer-wins corruption) and contend over the
// worktrees. Instead, hand focus to the window that's already open and exit.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(async () => {
    try {
      await boot();
    } catch (e) {
      console.error('[agenyra] boot failed:', (e && e.stack) || e);
      try { dialog.showErrorBox('Agenyra failed to start', String((e && e.message) || e)); } catch (_) {}
      app.quit();
      return;
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
// before-quit fires while the process is still healthy — kill every PTY here so
// no shell/agent is orphaned (see PtyManager.killAll).
app.on('before-quit', () => {
  if (pty) pty.killAll();
});
app.on('quit', () => {
  if (bus) bus.stop();
  if (engine) engine.stop();
  if (cost) cost.stop();
});
