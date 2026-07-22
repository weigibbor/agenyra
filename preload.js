'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the (sandboxed) renderer and the main process.
// nodeIntegration is OFF and contextIsolation is ON, so the renderer can only
// touch what we explicitly expose here.
contextBridge.exposeInMainWorld('mesh', {
  // panes / pty
  createPty: (id, opts) => ipcRenderer.invoke('pty:create', { id, opts }),
  input: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  setRole: (id, role) => ipcRenderer.send('pane:setRole', { id, role }),
  respawn: (id) => ipcRenderer.invoke('pane:respawn', { id }),
  markLaunched: (id) => ipcRenderer.send('pane:launched', { id }),
  setParent: (id, parentId) => ipcRenderer.invoke('pane:setParent', { id, parentId }),
  setActivation: (id, policy) => ipcRenderer.send('pane:setActivation', { id, policy }),
  setEffort: (id, effort) => ipcRenderer.send('pane:setEffort', { id, effort }),
  listPanes: () => ipcRenderer.invoke('panes:list'),

  // wiring
  addWire: (from, to) => ipcRenderer.send('wire:add', { from, to }),
  removeWire: (from, to) => ipcRenderer.send('wire:remove', { from, to }),
  listWires: () => ipcRenderer.invoke('wires:list'),
  route: (from, to, message, submit) => ipcRenderer.invoke('mesh:route', { from, to, message, submit }),

  // coordinator
  snapshot: () => ipcRenderer.invoke('coordinator:snapshot'),
  addTask: (title, steps) => ipcRenderer.invoke('task:add', { title, steps }),

  // folders (projects) — each is a git repo with its own HEAD + worktrees
  addFolder: () => ipcRenderer.invoke('folder:add'),
  listFolders: () => ipcRenderer.invoke('folder:list'),
  removeFolder: (id) => ipcRenderer.invoke('folder:remove', { id }),
  onFolders: (cb) => ipcRenderer.on('folders:update', (_e, d) => cb(d)),

  // worktrees
  worktreeDiff: (id) => ipcRenderer.invoke('worktree:diff', { id }),
  worktreeMerge: (id) => ipcRenderer.invoke('worktree:merge', { id }),
  worktreeRemove: (id, force) => ipcRenderer.invoke('worktree:remove', { id, force }),
  worktreeList: () => ipcRenderer.invoke('worktree:list'),

  // workbench file access (read-only observability over an agent's cwd)
  fsTree: (id) => ipcRenderer.invoke('fs:tree', { id }),
  fsRead: (id, path) => ipcRenderer.invoke('fs:read', { id, path }),
  fsChanges: (id) => ipcRenderer.invoke('fs:changes', { id }),
  fsDiff: (id, path) => ipcRenderer.invoke('fs:diff', { id, path }),
  fsWrite: (id, path, content) => ipcRenderer.invoke('fs:write', { id, path, content }),
  watchFs: (id) => ipcRenderer.send('fs:watch', { id }),
  onFsChanged: (cb) => ipcRenderer.on('fs:changed', (_e, d) => cb(d)),

  // autopilot missions (Phase 4B)
  missionAdd: (folderId, goal) => ipcRenderer.invoke('mission:add', { folderId, goal }),
  missionRemove: (id) => ipcRenderer.invoke('mission:remove', { id }),
  missionList: (folderId) => ipcRenderer.invoke('mission:list', { folderId }),
  missionApprove: (id) => ipcRenderer.invoke('mission:approve', { id }),
  missionRequestChanges: (id, comment) => ipcRenderer.invoke('mission:requestChanges', { id, comment }),
  missionRollback: (id) => ipcRenderer.invoke('mission:rollback', { id }),
  missionRetry: (id) => ipcRenderer.invoke('mission:retry', { id }),
  missionCancel: (id) => ipcRenderer.invoke('mission:cancel', { id }),
  autopilotGet: () => ipcRenderer.invoke('autopilot:get'),
  autopilotSet: (patch) => ipcRenderer.invoke('autopilot:set', patch),
  runlogList: (opts) => ipcRenderer.invoke('runlog:list', opts),
  digestGet: () => ipcRenderer.invoke('digest:get'),
  digestSeen: () => ipcRenderer.invoke('digest:seen'),
  costGet: () => ipcRenderer.invoke('cost:get'),
  attachSave: (dataUrl) => ipcRenderer.invoke('attach:save', { dataUrl }),
  wbtermEnsure: (folderId, cols, rows) => ipcRenderer.invoke('wbterm:ensure', { folderId, cols, rows }),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettings: (cb) => ipcRenderer.on('settings:update', (_e, d) => cb(d)),
  onCostUpdate: (cb) => ipcRenderer.on('cost:update', (_e, d) => cb(d)),
  onMissions: (cb) => ipcRenderer.on('missions:update', (_e, d) => cb(d)),
  onRunlogEvent: (cb) => ipcRenderer.on('runlog:event', (_e, d) => cb(d)),
  onAutopilotState: (cb) => ipcRenderer.on('autopilot:state', (_e, d) => cb(d)),

  // guardrails
  stopAll: () => ipcRenderer.send('agents:stop'),
  pauseGuard: (reason) => ipcRenderer.send('guard:pause', { reason }),
  setMaxExchanges: (n) => ipcRenderer.send('guard:setMax', { n }),
  resumeGuard: () => ipcRenderer.send('guard:resume'),
  resetGuard: () => ipcRenderer.send('guard:reset'),
  guardStats: () => ipcRenderer.invoke('guard:stats'),
  onGuardState: (cb) => ipcRenderer.on('guard:state', (_e, d) => cb(d)),
  onGuardPaused: (cb) => ipcRenderer.on('guard:paused', (_e, d) => cb(d)),

  // app + window
  appInfo: () => ipcRenderer.invoke('app:info'),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),

  // events (main -> renderer)
  onData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, d) => cb(d)),
  onBusMessage: (cb) => ipcRenderer.on('bus:message', (_e, d) => cb(d)),
  onAnnounce: (cb) => ipcRenderer.on('bus:announce', (_e, d) => cb(d)),
  onCoordinatorState: (cb) => ipcRenderer.on('coordinator:state', (_e, d) => cb(d)),
  onWires: (cb) => ipcRenderer.on('wires:update', (_e, d) => cb(d)),
  onPanes: (cb) => ipcRenderer.on('panes:update', (_e, d) => cb(d)),
});
