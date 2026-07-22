'use strict';
// Auto-update via electron-updater against GitHub Releases (weigibbor/agenyra —
// the feed URL ships inside the packaged app as app-update.yml, generated from
// package.json "publish"). The renderer only ever sees what the updater really
// reported: actual download percent, actual versions, actual errors — never a
// synthetic progress state.
const { app } = require('electron');

const FIRST_CHECK_MS = 10 * 1000; // let boot + first paint finish first
const RECHECK_MS = 4 * 60 * 60 * 1000;

class Updater {
  // send(channel, payload) — the same main→renderer forwarder main.js uses.
  constructor(send) {
    this.send = send;
    this.auto = null; // electron-updater instance; stays null in dev runs
    this.timer = null;
    // phases: dev | idle | checking | downloading | ready | none | error
    this.state = { phase: app.isPackaged ? 'idle' : 'dev', version: app.getVersion() };
  }

  set(patch) {
    this.state = Object.assign({}, this.state, patch);
    this.send('update:state', this.state);
  }

  start() {
    // Dev runs have no feed (app-update.yml only exists in packaged builds) —
    // electron-updater would just throw on every check.
    if (!app.isPackaged) return;
    const { autoUpdater } = require('electron-updater');
    this.auto = autoUpdater;
    // Surface the updater's own check/download/verify lines in the main log —
    // an offline/404/signature failure throws inside checkForUpdates and would
    // otherwise be invisible (the UI just shows no chip).
    autoUpdater.logger = console;
    autoUpdater.autoDownload = true;
    // A downloaded update applies on normal quit too, not only via the restart
    // chip — nobody stays pinned to an old build by never clicking it.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this.set({ phase: 'downloading', next: info.version, percent: null }));
    autoUpdater.on('update-not-available', () => this.set({ phase: 'none', checkedAt: Date.now() }));
    autoUpdater.on('download-progress', (p) => this.set({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))),
      transferred: p.transferred || 0,
      total: p.total || 0,
    }));
    autoUpdater.on('update-downloaded', (info) => this.set({ phase: 'ready', next: info.version, percent: 100 }));
    // Offline is a normal state for a desktop app: record the error, keep the
    // interval running, never crash out of the updater.
    autoUpdater.on('error', (err) => this.set({ phase: 'error', error: String((err && err.message) || err).slice(0, 200) }));
    setTimeout(() => this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check(), RECHECK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  check() {
    if (this.auto) this.auto.checkForUpdates().catch(() => {}); // the 'error' event already carries it
  }

  install() {
    // Renderer clicks arrive here, but never trust the renderer's view of the
    // state — only restart when a verified update is actually on disk.
    if (this.auto && this.state.phase === 'ready') this.auto.quitAndInstall();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { Updater };
