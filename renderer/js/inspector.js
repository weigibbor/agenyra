'use strict';
/* inspector.js — the right dock: Tasks, Bus, Locks, Merge. All bound to real
 * backend state (coordinator snapshot, the bus log, worktree diffs). The Merge
 * pane hands each worker branch to the Review sheet. */
(function () {
  const AM = window.AM, mesh = AM.mesh, el = AM.el, esc = AM.esc, dur = AM.dur, clock = AM.clock;

  function folderAgents() { return AM.agentsInFolder(AM.state.selectedFolderId); }

  // shared diff colorizer (used by review.js too)
  function colorizeDiff(patch, max) {
    const lines = String(patch || '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/^diff --git|^index |^new file|^deleted file/.test(ln)) continue;
      if (max && out.length >= max) { out.push('<span class="quiet">…</span>'); break; }
      let cls = '';
      if (/^\+\+\+|^---/.test(ln)) cls = 'quiet';
      else if (ln[0] === '+') cls = 'add';
      else if (ln[0] === '-') cls = 'del';
      else if (/^@@/.test(ln)) cls = 'quiet';
      out.push(cls ? '<span class="' + cls + '">' + esc(ln) + '</span>' : esc(ln));
    }
    return out.join('\n');
  }
  AM.colorizeDiff = colorizeDiff;

  // ---------- Tasks ----------
  function checklist(steps) {
    if (!steps || !steps.length) return '';
    const rows = steps.map((s) => {
      const cls = s.status === 'done' ? 'done' : (s.status === 'active' ? '' : 'quiet');
      return '<div class="' + cls + '">' + esc(s.label) + '</div>';
    });
    return '<div class="checklist">' + rows.join('') + '</div>';
  }
  function taskCard(t) {
    const active = t.status === 'in_progress';
    const done = (t.steps || []).filter((s) => s.status === 'done').length;
    const tot = (t.steps || []).length;
    const dotCls = t.status === 'done' ? 'ok' : (t.status === 'in_progress' ? 'dot live' : (t.status === 'review' ? 'dot wait' : 'dot'));
    const glyph = t.status === 'done' ? '<span class="ok">✓</span>' : '<span class="' + dotCls + '"></span>';
    const statusTxt = t.status === 'in_progress' ? (tot ? done + '/' + tot : 'active')
      : t.status === 'review' ? 'Needs approval'
      : t.status === 'done' ? 'Done' : 'Queued';
    let html = '<div class="task' + (active ? ' active' : '') + '"><div class="task-top">' + glyph +
      '<span class="task-name">' + esc(t.title) + '</span>' +
      (t.assignee ? '<span class="task-status mono">' + esc(t.assignee) + '</span>' : '') +
      '<span class="task-status">' + statusTxt + '</span></div>';
    if (active) html += checklist(t.steps);
    html += '</div>';
    return html;
  }
  function renderTasks() {
    const pane = el('pane-tasks');
    const tasks = AM.state.snapshot.tasks || [];
    if (!tasks.length) { pane.innerHTML = '<div class="section-head">Tasks <span>0</span></div><p class="muted" style="font-size:11px;padding:6px">No tasks yet. HEAD creates them as it plans, or add a mission in Autopilot.</p>'; return; }
    const groups = [
      ['In progress', tasks.filter((t) => t.status === 'in_progress')],
      ['Review', tasks.filter((t) => t.status === 'review')],
      ['Backlog', tasks.filter((t) => t.status === 'todo')],
      ['Done', tasks.filter((t) => t.status === 'done')],
    ];
    pane.innerHTML = groups.filter((g) => g[1].length).map((g) =>
      '<section class="section"><div class="section-head">' + g[0] + ' <span>' + g[1].length + '</span></div>' +
      g[1].map(taskCard).join('') + '</section>').join('');
  }

  // ---------- Bus ----------
  function renderBus() {
    const pane = el('pane-bus');
    const log = AM.state.busLog;
    let html = '<div class="section-head">Message bus <span>Live</span></div>';
    if (!log.length) { pane.innerHTML = html + '<p class="muted" style="font-size:11px;padding:6px">No messages yet. Agent-to-agent traffic shows here.</p>'; return; }
    html += log.slice(-40).reverse().map((m) =>
      '<div class="bus"><div class="bus-meta">' + esc(m.from) + ' → ' + esc(m.to) +
      '<time>' + clock(m.at) + '</time></div><div class="bus-body">' + esc(m.message) + '</div></div>').join('');
    pane.innerHTML = html;
  }

  // ---------- Locks ----------
  function renderLocks() {
    const pane = el('pane-locks');
    const locks = (AM.state.snapshot.locks || []).filter((l) => l.holder);
    let html = '<div class="section-head">Resource locks <span>' + locks.length + '</span></div>';
    if (!locks.length) { pane.innerHTML = html + '<p class="muted" style="font-size:11px;padding:6px">No active locks. Agents announce shared-resource work before they begin.</p>'; return; }
    html += locks.map((l) => {
      const waiters = (l.waiters || []).length ? '<div class="checklist"><div>Waiting: ' + esc(l.waiters.join(', ')) + '</div></div>' : '';
      return '<div class="task active"><div class="task-top"><span class="dot wait"></span><span class="task-name mono">' + esc(l.resource) +
        '</span><span class="task-status">' + esc(l.holder) + ' · ' + dur(l.since) + '</span></div>' + waiters + '</div>';
    }).join('');
    html += '<p class="muted" style="font-size:11px;padding:4px">Locks are advisory. Agents request them before touching shared resources.</p>';
    pane.innerHTML = html;
  }

  // ---------- Merge ----------
  // renderMerge is async and fires from several events ('panes' often arrives
  // twice per spawn) — a generation token stops an older run from appending
  // its remaining cards into a pane a newer run has already reset.
  let mergeGen = 0;
  async function renderMerge() {
    const gen = ++mergeGen;
    const pane = el('pane-merge');
    const workers = folderAgents().filter((a) => a.role !== 'head' && AM.state.paneMeta[a.id] && AM.state.paneMeta[a.id].branch);
    if (!workers.length) {
      pane.innerHTML = '<div class="section-head">Branches <span>0</span></div><p class="muted" style="font-size:11px;padding:6px">No worker branches yet. Spawn a worker — it gets an isolated agent/&lt;id&gt; branch.</p>';
      return;
    }
    pane.innerHTML = '<div class="section-head">Branches <span>' + workers.length + '</span></div>';
    for (const w of workers) {
      if (gen !== mergeGen) return; // a newer render reset the pane — stop appending
      const branch = AM.state.paneMeta[w.id].branch;
      const card = document.createElement('div'); card.className = 'task active';
      card.innerHTML = '<div class="task-top"><span class="task-name mono">' + esc(branch) + '</span><span class="task-status">…</span></div>';
      pane.appendChild(card);
      let d;
      try { d = await mesh.worktreeDiff(w.id); } catch (e) { d = { error: e && e.message }; }
      if (gen !== mergeGen) return;
      const status = card.querySelector('.task-status');
      if (!d || d.error) { status.textContent = '—'; continue; }
      const hasChanges = d.patch && d.patch.trim();
      status.textContent = d.dirty ? 'uncommitted' : (hasChanges ? (d.stat ? d.stat.split('\n').pop().replace(/^\s*\d+\s+file[^,]*,?\s*/, '') || 'changes' : 'changes') : '0 ahead');
      if (hasChanges) {
        const pre = document.createElement('pre'); pre.className = 'diff'; pre.innerHTML = colorizeDiff(d.patch, 6);
        card.appendChild(pre);
      }
      if (hasChanges && !d.dirty) {
        const btn = document.createElement('button'); btn.className = 'primary small'; btn.style.width = '100%'; btn.style.marginTop = '8px';
        btn.textContent = 'Review & merge'; btn.onclick = () => AM.openReview(true, w.id);
        card.appendChild(btn);
      } else if (d.dirty) {
        const p = document.createElement('p'); p.className = 'muted'; p.style.cssText = 'font-size:11px;margin:6px 0 0';
        p.textContent = 'Uncommitted changes — worker must commit first';
        card.appendChild(p);
      }
    }
    if (gen !== mergeGen) return;
    const note = document.createElement('p'); note.className = 'muted'; note.style.cssText = 'font-size:11px;padding:6px';
    note.textContent = 'Only the HEAD merges to main. Review a branch to approve it.';
    pane.appendChild(note);
  }
  AM.renderMerge = renderMerge;

  function renderInspector() { renderTasks(); renderBus(); renderLocks(); renderMerge(); }
  AM.renderInspector = renderInspector;

  // ---------- subscriptions ----------
  AM.on('snapshot', () => { renderTasks(); renderLocks(); });
  AM.on('buslog', renderBus);
  AM.on('panes', renderMerge);
  AM.on('selectFolder', renderMerge);
  AM.on('inspectorTab', (p) => { if (p === 'merge') renderMerge(); });
})();
