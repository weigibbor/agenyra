'use strict';
/* app.js — bootstrap. Runs last: pulls initial state from the backend, seeds
 * the store, then drives the first render of every surface. Live updates after
 * this arrive through core.js's mesh.on* → AM.emit fan-out. */
(function () {
  const AM = window.AM, mesh = AM.mesh;

  async function boot() {
    try {
      const info = await mesh.appInfo();
      if (info) { AM.state.busPort = info.busPort || 0; AM.state.busToken = info.busToken || ''; if (info.startedAt) AM.state.startedAt = info.startedAt; }
      AM.state.folders = (await mesh.listFolders()) || [];
      AM.state.panes = (await mesh.listPanes()) || [];
      AM.state.snapshot = (await mesh.snapshot()) || AM.state.snapshot;
      AM.state.guard = (await mesh.guardStats()) || AM.state.guard;
      // Rebuild per-pane worktree/branch info so the Merge tab survives a reload.
      const wts = (await mesh.worktreeList()) || [];
      wts.forEach((w) => { AM.state.paneMeta[w.id] = { branch: w.branch, worktreePath: w.path }; });
      // Fetch live wires so the mesh + sidebar rail survive a reload.
      if (mesh.listWires) AM.state.wires = (await mesh.listWires()) || [];
    } catch (e) {
      console.error('[agenyra] boot failed:', e && e.message);
    }

    if (AM.state.folders.length && !AM.state.selectedFolderId) {
      AM.state.selectedFolderId = AM.state.folders[0].id;
    }

    // Drive every subscriber once with the seeded state.
    AM.emit('folders', AM.state.folders);
    AM.emit('panes', AM.state.panes);
    AM.emit('wires', AM.state.wires);
    AM.emit('snapshot', AM.state.snapshot);
    AM.emit('guard', AM.state.guard);

    // Direct first render for surfaces that key off selection/view.
    if (AM.renderSidebar) AM.renderSidebar();
    if (AM.renderStatus) AM.renderStatus();
    if (AM.renderChat) AM.renderChat();
    if (AM.renderMesh) AM.renderMesh();
    if (AM.renderAutopilot) AM.renderAutopilot();
    if (AM.renderInspector) AM.renderInspector();

    // Phase 5: announce the auto-restored session.
    const restored = AM.state.panes.filter((p) => p.restored).length;
    if (restored && AM.toast) {
      AM.toast('Restored ' + restored + ' agent' + (restored === 1 ? '' : 's') + ' · ' + (AM.state.wires || []).length + ' wire' + (AM.state.wires.length === 1 ? '' : 's'));
    }

    console.log('[agenyra] renderer ready · folders=' + AM.state.folders.length + ' panes=' + AM.state.panes.length + ' restored=' + restored);
  }

  boot();
})();
