'use strict';
/* review.js — the Review sheet. Loads a worker's real worktree diff, splits it
 * per file, and lets the HEAD Approve & merge (real git merge) or Request
 * changes (routed to the worker on the bus as a new instruction). */
(function () {
  const AM = window.AM, mesh = AM.mesh, el = AM.el, esc = AM.esc;
  const review = el('review');
  let currentAgent = null;
  let currentMission = null; // when set, Approve/Request go through the Autopilot engine
  let files = [];
  let activeFile = 0;
  let reviewGen = 0; // stale-diff guard: a slower load must not overwrite a newer review

  function show(on) { review.classList.toggle('open', on); AM.backdropState(); }

  function splitFiles(patch) {
    const parts = String(patch || '').split(/\n(?=diff --git )/);
    return parts.filter((p) => p.trim()).map((p) => {
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(p);
      const name = m ? m[2].replace(/"$/, '') : 'file';
      const adds = (p.match(/^\+(?!\+\+)/gm) || []).length;
      return { name: name, adds: adds, patch: p };
    });
  }
  function renderFiles() {
    const box = el('reviewFiles');
    if (!files.length) {
      box.innerHTML = '<div class="muted" style="padding:8px;font-size:11px">No committed changes on this branch yet.</div>';
      el('reviewDiff').textContent = 'The worker has not committed anything to review.';
      return;
    }
    box.innerHTML = files.map((f, i) =>
      '<button class="file' + (i === activeFile ? ' active' : '') + '" type="button" data-i="' + i + '">' +
      esc(f.name) + '<span>+' + f.adds + '</span></button>').join('');
    box.querySelectorAll('.file').forEach((b) => {
      b.onclick = () => { activeFile = +b.dataset.i; renderFiles(); };
    });
    el('reviewDiff').innerHTML = AM.colorizeDiff(files[activeFile].patch, 0);
  }
  function findReviewable() {
    const w = AM.agentsInFolder(AM.state.selectedFolderId).find((a) => a.role !== 'head' && AM.state.paneMeta[a.id] && AM.state.paneMeta[a.id].branch);
    return w ? w.id : null;
  }

  async function openReview(on, agentId, missionId) {
    const gen = ++reviewGen; // any in-flight diff load is now stale
    if (!on) { show(false); return; }
    currentMission = missionId || null;
    agentId = agentId || findReviewable();
    if (!agentId) {
      currentAgent = null; files = [];
      el('reviewTitle').textContent = 'Review';
      el('reviewChip').textContent = '';
      el('reviewFiles').innerHTML = '';
      el('reviewDiff').textContent = 'Nothing to review right now. Workers commit in their worktrees, then hand the branch to HEAD.';
      show(true);
      return;
    }
    currentAgent = agentId; activeFile = 0;
    const branch = AM.state.paneMeta[agentId] ? AM.state.paneMeta[agentId].branch : agentId;
    el('reviewTitle').textContent = 'Review ' + branch;
    el('reviewChip').textContent = '1 approval';
    el('reviewFiles').innerHTML = '<div class="muted" style="padding:8px;font-size:11px">Loading diff…</div>';
    el('reviewDiff').textContent = '';
    show(true);
    let d;
    try { d = await mesh.worktreeDiff(agentId); } catch (e) { d = { error: e && e.message }; }
    if (gen !== reviewGen) return; // a newer review superseded this one mid-load
    if (!d || d.error) {
      files = []; el('reviewFiles').innerHTML = '';
      el('reviewDiff').textContent = 'Could not load diff: ' + ((d && d.error) || 'unknown');
      return;
    }
    files = splitFiles(d.patch);
    renderFiles();
  }
  AM.openReview = openReview;

  el('reviewClose').onclick = () => show(false);
  document.querySelectorAll('[data-review]').forEach((b) => { b.onclick = () => openReview(true); });

  el('approveMerge').onclick = async () => {
    // Mission context (Phase 4B): the ENGINE checkpoints + merges + advances.
    if (currentMission) {
      let r;
      try { r = await mesh.missionApprove(currentMission); } catch (e) { r = { ok: false, error: e && e.message }; }
      if (r && r.ok) {
        AM.state.mergedCount += r.merged || 0;
        AM.toast('Approved — ' + (r.merged || 0) + ' branch(es) merged to main');
        show(false);
      } else {
        AM.toast('Approve failed: ' + ((r && r.error) || 'error'));
        if (r && r.conflict) show(false);
      }
      return;
    }
    if (!currentAgent) { show(false); return; }
    const id = currentAgent;
    const branch = AM.state.paneMeta[id] ? AM.state.paneMeta[id].branch : id;
    let r;
    try { r = await mesh.worktreeMerge(id); } catch (e) { r = { ok: false, error: e && e.message }; }
    if (r && r.ok) {
      AM.state.mergedCount++;
      AM.pushTimeline('Merged ' + branch + ' → main', 'merge');
      AM.emit('merged', { agent: id, branch: branch });
      AM.toast('Merged ' + branch + ' to main');
      show(false);
      if (AM.renderMerge) AM.renderMerge();
    } else {
      AM.toast('Merge failed: ' + ((r && r.error) || 'conflict'));
    }
  };
  el('requestChanges').onclick = async () => {
    const input = el('changeRequest');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    if (currentMission) {
      const r = await mesh.missionRequestChanges(currentMission, text);
      AM.toast(r && r.ok ? 'Change request routed — mission back to running' : ((r && r.error) || 'failed'));
    } else if (currentAgent) {
      mesh.route('human', currentAgent, '[REVIEW] Change request: ' + text, true);
      AM.pushTimeline('Requested changes on ' + currentAgent, 'review');
      AM.toast('Change request sent to ' + currentAgent);
    }
    input.value = '';
    show(false);
  };
})();
