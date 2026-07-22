'use strict';
/* autopilot.js — the Autopilot view, Phase 4B: bound to the REAL engine in the
 * main process. The master switch and mode drive the engine (persisted in
 * .state/autopilot.json), the Mission Queue is the persistent mission store,
 * the Run Timeline reads the append-only runlog (survives restarts), and the
 * Morning Digest is computed from real history since you last looked. */
(function () {
  const AM = window.AM, mesh = AM.mesh, el = AM.el, esc = AM.esc, dur = AM.dur, clock = AM.clock;

  const DESC = {
    supervised: 'Pauses before every merge and leaves an approval item for you.',
    full: 'The merge officer decides and the run continues without check-ins.',
  };
  const ST = {
    queued: { cls: '', glyph: '', sub: 'Queued', meta: '—' },
    running: { cls: 'running', glyph: '', sub: 'Running', meta: '' },
    awaiting_review: { cls: '', glyph: '!', sub: 'Merge ready for review', meta: '' },
    merging: { cls: 'running', glyph: '', sub: 'Merging…', meta: '' },
    done: { cls: 'done', glyph: '✓', sub: 'Done', meta: '' },
    blocked: { cls: '', glyph: '×', sub: 'Blocked', meta: '' },
    rolled_back: { cls: '', glyph: '↩', sub: 'Rolled back', meta: '' },
  };
  let ap = { autopilotOn: false, mode: 'supervised', autoResumeMinutes: 0, budgetCap: 0, lastSeenTs: 0 };
  let missionsCache = [];
  let runlogCache = [];

  const inAuto = () => AM.state.view === 'autopilot';

  // ---------- master switch + run pill ----------
  function syncControls() {
    const on = ap.autopilotOn;
    const sw = el('autoSwitch');
    sw.classList.toggle('off', !on);
    sw.setAttribute('aria-pressed', String(on));
    document.querySelectorAll('#autoMode button').forEach((b) => b.classList.toggle('active', b.dataset.auto === ap.mode));
    el('modeDescription').textContent = DESC[ap.mode] || DESC.supervised;
    if (document.activeElement !== el('autoResumeMin')) el('autoResumeMin').value = ap.autoResumeMinutes || '';
    const paused = AM.state.guard.paused;
    const pill = el('runPill');
    pill.classList.toggle('paused', !on || paused);
    const dot = pill.querySelector('.dot');
    if (dot) dot.classList.toggle('live', on && !paused);
    el('runText').textContent = paused ? 'Paused' : (on ? 'Autopilot' : 'Manual');
  }
  el('autoSwitch').onclick = async () => {
    ap = await mesh.autopilotSet({ autopilotOn: !ap.autopilotOn });
    AM.toast(ap.autopilotOn ? 'Autopilot ON — queued missions will run' : 'Autopilot OFF');
    renderAutopilot();
  };
  document.querySelectorAll('#autoMode button').forEach((b) => {
    b.onclick = async () => {
      ap = await mesh.autopilotSet({ mode: b.dataset.auto === 'full' ? 'full' : 'supervised' });
      syncControls();
    };
  });
  el('autoResumeMin').addEventListener('change', async function () {
    const n = Math.max(0, Math.min(120, parseFloat(this.value) || 0));
    ap = await mesh.autopilotSet({ autoResumeMinutes: n });
    AM.toast(n ? 'Auto-resume after ' + n + ' min (max 2/hour)' : 'Auto-resume off');
  });

  // ---------- metrics + digest ----------
  function renderMetrics() {
    el('aSession').textContent = dur(AM.state.startedAt) || '0m';
    el('aExch').textContent = AM.state.guard.total;
    el('aExchNote').textContent = 'of ' + (AM.state.guard.max || '∞');
    el('aMerged').textContent = missionsCache.filter((m) => (m.mergeCommits || []).length).length || AM.state.mergedCount;
    const needs = missionsCache.filter((m) => m.status === 'awaiting_review').length;
    el('aNeeds').textContent = needs;
  }
  async function renderDigest() {
    let d;
    try { d = await mesh.digestGet(); } catch (_) { return; }
    const btn = el('digestReview');
    if (!d || (!d.missionsDone && !d.missionsBlocked && !d.merges && !d.needsYou.length)) {
      el('digestText').textContent = ap.autopilotOn
        ? 'Nothing new since you last looked. Queue missions and let the run move.'
        : 'The digest summarizes what happened while you were away. Turn Autopilot on and queue missions.';
      btn.classList.add('hidden');
      return;
    }
    const span = d.firstTs ? dur(d.firstTs) : '';
    const bits = [];
    if (d.missionsDone) bits.push(d.missionsDone + ' mission' + (d.missionsDone === 1 ? '' : 's') + ' done');
    if (d.merges) bits.push(d.merges + ' merged to main');
    if (d.missionsBlocked) bits.push(d.missionsBlocked + ' blocked');
    if (d.guardPauses) bits.push(d.guardPauses + ' guard pause' + (d.guardPauses === 1 ? '' : 's'));
    el('digestText').textContent = (span ? 'Last ' + span + ': ' : '') + (bits.join(' · ') || 'quiet run') +
      (d.needsYou.length ? ' — needs you: ' + d.needsYou.map((n) => n.missionId).join(', ') : '');
    btn.classList.toggle('hidden', !d.needsYou.length);
    btn.onclick = () => {
      const first = d.needsYou[0];
      const m = missionsCache.find((x) => x.id === first.missionId);
      openMissionReview(m);
    };
  }
  function openMissionReview(m) {
    if (m && m.status === 'awaiting_review' && (m.branches || []).length) {
      AM.openReview(true, m.branches[0].agentId, m.id);
    } else {
      AM.openReview(true);
    }
  }

  // ---------- mission queue ----------
  function missionRow(m) {
    const st = ST[m.status] || ST.queued;
    const div = document.createElement('div');
    div.className = 'mission ' + st.cls;
    const took = m.startedAt && m.finishedAt ? dur(Date.now() - (m.finishedAt - m.startedAt)) : '';
    let sub = st.sub;
    if (m.status === 'running') sub = 'Running · ' + (m.assigneeHead || '');
    else if (m.status === 'blocked') sub = 'Blocked · ' + (m.blockReason || '');
    else if (m.status === 'done' && m.summary) sub = m.summary;
    div.innerHTML = '<span class="mission-state">' + st.glyph + '</span>' +
      '<div><div class="mission-name">' + esc(m.goal.length > 60 ? m.goal.slice(0, 60) + '…' : m.goal) + '</div>' +
      '<div class="mission-sub" title="' + esc(m.blockReason || m.summary || '') + '">' + esc(sub) + '</div></div>';
    const right = document.createElement('span'); right.className = 'mission-meta';
    if (m.status === 'awaiting_review') {
      const btn = document.createElement('button'); btn.className = 'button small'; btn.textContent = 'Review';
      btn.onclick = () => openMissionReview(m);
      right.replaceChildren(btn);
    } else if (m.status === 'done' && (m.mergeCommits || []).length) {
      const btn = document.createElement('button'); btn.className = 'reply-action'; btn.textContent = '↩';
      btn.title = 'Restore checkpoint — undo this merge';
      btn.onclick = async () => {
        const r = await mesh.missionRollback(m.id);
        AM.toast(r && r.ok ? 'Rolled back ' + m.id : (r && r.error) || 'Rollback failed');
      };
      right.replaceChildren(btn);
    } else if (m.status === 'queued') {
      const btn = document.createElement('button'); btn.className = 'reply-action'; btn.textContent = '×';
      btn.title = 'Remove mission';
      btn.onclick = async () => { await mesh.missionRemove(m.id); };
      right.replaceChildren(btn);
    } else if (m.status === 'running') {
      const btn = document.createElement('button'); btn.className = 'reply-action'; btn.textContent = '×';
      btn.title = 'Cancel mission (notifies the HEAD)';
      btn.onclick = async () => {
        const r = await mesh.missionCancel(m.id);
        AM.toast(r && r.ok ? 'Cancelled ' + m.id : (r && r.error) || 'Cancel failed');
      };
      right.replaceChildren(btn);
    } else if (m.status === 'blocked' || m.status === 'rolled_back') {
      const btn = document.createElement('button'); btn.className = 'reply-action'; btn.textContent = '↻';
      btn.title = 'Retry — back to the queue';
      btn.onclick = async () => {
        const r = await mesh.missionRetry(m.id);
        AM.toast(r && r.ok ? 'Requeued ' + m.id : (r && r.error) || 'Retry failed');
      };
      right.replaceChildren(btn);
    } else {
      right.textContent = took || m.id;
    }
    div.appendChild(right);
    return div;
  }
  function renderMissions() {
    const box = el('missionQueue');
    const folderId = AM.state.selectedFolderId;
    const list = missionsCache.filter((m) => !folderId || m.folderId === folderId);
    const done = list.filter((m) => m.status === 'done').length;
    el('missionSummary').textContent = done + ' of ' + list.length + ' done';
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="muted" style="font-size:12px;padding:14px 4px">No missions yet. Add one — with Autopilot on, the folder\'s HEAD picks it up automatically.</p>';
    } else {
      list.forEach((m) => box.appendChild(missionRow(m)));
    }
    const add = document.createElement('div'); add.className = 'mission'; add.style.cursor = 'pointer';
    add.innerHTML = '<span class="mission-state">＋</span><div><div class="mission-name muted">Add mission</div></div>';
    add.onclick = beginAddMission;
    box.appendChild(add);
  }
  function beginAddMission() {
    const box = el('missionQueue');
    if (box.querySelector('.mission-add-row')) { box.querySelector('.mission-add-row input').focus(); return; }
    const row = document.createElement('div'); row.className = 'mission mission-add-row';
    row.innerHTML = '<span class="mission-state">＋</span><input type="text" placeholder="Mission goal, e.g. Add signup flow with tests" ' +
      'style="flex:1;min-width:0;height:30px;border:1px solid var(--line2);border-radius:8px;background:var(--surface);color:var(--text);outline:0;padding:0 10px">';
    const input = row.querySelector('input');
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const goal = input.value.trim();
        if (goal) {
          const r = await mesh.missionAdd(AM.state.selectedFolderId, goal);
          AM.toast(r && r.ok ? 'Mission queued' : (r && r.error) || 'Could not add mission');
        } else renderMissions();
      } else if (e.key === 'Escape') renderMissions();
    });
    box.appendChild(row);
    input.focus();
  }
  el('addMission').onclick = beginAddMission;

  // ---------- run timeline (persistent) ----------
  const EV_TEXT = {
    'mission.queued': (e) => 'Queued ' + e.missionId + ': ' + ((e.data && e.data.goal) || ''),
    'mission.started': (e) => (e.data && e.data.head ? e.data.head + ' took ' : 'Started ') + e.missionId,
    'mission.done': (e) => e.missionId + ' done' + (e.data && e.data.summary ? ' — ' + e.data.summary : ''),
    'mission.blocked': (e) => (e.missionId || 'mission') + ' blocked — ' + ((e.data && e.data.reason) || ''),
    'mission.review': (e) => e.missionId + ' ready for merge review',
    'mission.merged': (e) => 'Merged ' + ((e.data && e.data.branch) || '') + ' → main (' + e.missionId + ')',
    'mission.rolledback': (e) => 'Rolled back ' + e.missionId,
    'officer.verdict': (e) => 'Merge officer: ' + ((e.data && e.data.verdict) || '') + ' (' + e.missionId + ')',
    'guard.paused': (e) => 'Guard paused — ' + ((e.data && e.data.reason) || ''),
    'guard.autoresumed': () => 'Autopilot auto-resumed after guard pause',
    'watchdog.agent_exit': (e) => 'Agent ' + ((e.data && e.data.agentId) || '') + ' died mid-mission',
    'autopilot.on': () => 'Autopilot turned ON',
    'autopilot.off': () => 'Autopilot turned OFF',
  };
  function renderTimeline() {
    const box = el('timeline');
    if (!runlogCache.length) {
      box.innerHTML = '<p class="muted" style="font-size:12px;padding:14px 4px">Nothing yet. Mission activity, merges, and guard events land here — and survive restarts.</p>';
      return;
    }
    box.innerHTML = runlogCache.slice(-14).reverse().map((e) => {
      const fn = EV_TEXT[e.type];
      const text = fn ? fn(e) : e.type;
      return '<div class="timeline-row"><time>' + clock(e.ts) + '</time><span class="timeline-dot"></span><span>' + esc(text) + '</span></div>';
    }).join('');
  }

  async function refresh() {
    try {
      ap = await mesh.autopilotGet();
      missionsCache = (await mesh.missionList()) || [];
      runlogCache = (await mesh.runlogList({ sinceTs: Date.now() - 86400000, limit: 120 })) || [];
    } catch (_) {}
  }
  async function renderAutopilot() {
    await refresh();
    syncControls();
    renderMetrics();
    renderMissions();
    renderTimeline();
    renderDigest();
  }
  AM.renderAutopilot = renderAutopilot;
  AM.missionsCache = () => missionsCache;

  // ---------- subscriptions ----------
  AM.on('view', (v) => {
    if (v === 'autopilot') {
      renderAutopilot();
      mesh.digestSeen && setTimeout(() => mesh.digestSeen(), 4000); // looked at it → reset the digest window
    }
  });
  if (mesh.onMissions) mesh.onMissions((list) => { missionsCache = list || []; if (inAuto()) { renderMissions(); renderMetrics(); } });
  if (mesh.onRunlogEvent) mesh.onRunlogEvent((ev) => {
    runlogCache.push(ev);
    if (runlogCache.length > 300) runlogCache.shift();
    if (inAuto()) { renderTimeline(); renderDigest(); }
  });
  if (mesh.onAutopilotState) mesh.onAutopilotState((s) => { ap = s || ap; syncControls(); });
  AM.on('guard', () => { syncControls(); if (inAuto()) renderMetrics(); });
  AM.on('selectFolder', () => { if (inAuto()) renderMissions(); });
  setInterval(() => { if (inAuto()) el('aSession').textContent = dur(AM.state.startedAt) || '0m'; }, 30000);

  // initial pill state
  mesh.autopilotGet && mesh.autopilotGet().then((s) => { ap = s || ap; syncControls(); }).catch(() => {});
})();
