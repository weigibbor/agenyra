'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { git } = require('./worktree');
const { writeFileAtomic } = require('./atomic');

// Kill a child AND its descendants. shell:true wraps the real process in a shell,
// so plain child.kill() can orphan the grandchild — walk the tree instead.
function killTree(child) {
  if (!child || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnTree(child.pid);
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } // negative pid = the whole process group
      catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
    }
  } catch (_) { try { child.kill(); } catch (_) {} }
}
function spawnTree(pid) {
  try { require('child_process').spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
}

// Phase 4B: the Autopilot engine — deterministic main-process code that keeps
// the run moving while the human sleeps. AI appears at exactly one judgment
// point (the Merge Officer, Full Auto mode); everything else is plumbing.
//
// Loop (per folder): dequeue next queued mission → validate topology (a HEAD
// exists, it can SEND somewhere, and someone can send back) → route the goal
// + mission protocol to the HEAD → running. Completion comes ONLY from the
// assigned HEAD via `mesh mission done|blocked`. Merges are executed HERE at
// the folder repo root (never by an agent in its own worktree): Supervised
// gates on the human (Review sheet), Full Auto asks the Merge Officer.
class AutopilotEngine extends EventEmitter {
  constructor({ stateDir, missions, runlog, pty, router, guard, folders }) {
    super();
    this.missions = missions;
    this.runlog = runlog;
    this.pty = pty;
    this.router = router;
    this.guard = guard;
    this.folders = folders; // Map<folderId, {id, name, repo, wtm, isGit}>
    this.file = path.join(stateDir, 'autopilot.json');
    this.settings = { autopilotOn: false, mode: 'supervised', autoResumeMinutes: 0, budgetCap: 0, lastSeenTs: 0 };
    this.mergeLocks = {};    // folderId -> true while a merge/officer pass runs
    this.resumeTimer = null;
    this.resumeCount = [];   // timestamps of recent auto-resumes (max 2/hour)
    this._loadSettings();

    // A mission left active by a previous process was interrupted — surface it.
    // (Only running/merging: awaiting_review survives restarts by design.)
    const interrupted = this.missions.markInterrupted();
    if (interrupted) this.runlog.add('mission.blocked', { data: { reason: 'interrupted (app restart)', count: interrupted } });
    // If the previous process died mid-merge, the repo may hold a dangling
    // MERGE_HEAD — abort it so the root stays clean for the next merge.
    for (const folder of this.folders.values()) {
      if (!folder.isGit || !folder.repo) continue;
      try {
        if (fs.existsSync(path.join(folder.repo, '.git', 'MERGE_HEAD'))) {
          git(folder.repo, ['merge', '--abort']).then(
            () => this.runlog.add('mission.merge_aborted', { folderId: folder.id, data: { reason: 'dangling merge from previous run' } }),
            () => {}
          );
        }
      } catch (_) {}
    }
    this.lastBusTs = {};   // folderId -> last bus activity (stall detector)
    this.stallWarned = {}; // folderId -> ts of last stall warning

    // Watchdog: an agent dying mid-mission blocks that mission loudly.
    this.pty.on('exit', ({ id, exitCode }) => this._onAgentExit(id, exitCode));
    // Guard pauses feed the runlog + optional auto-resume policy.
    this.guard.on('paused', (reason) => this._onGuardPaused(reason));

    this.tick = this.tick.bind(this);
    this.timer = setInterval(this.tick, 4000);
  }

  // ---------- settings ----------
  _loadSettings() {
    try {
      if (fs.existsSync(this.file)) Object.assign(this.settings, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) { console.log(`[autopilot] settings load failed: ${e.message}`); }
  }
  _saveSettings() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.settings, null, 2));
    } catch (e) { console.log(`[autopilot] settings save failed: ${e.message}`); }
    this.emit('state', this.getState());
  }
  getState() {
    return Object.assign({}, this.settings);
  }
  setState(patch) {
    const prevOn = this.settings.autopilotOn;
    ['autopilotOn', 'mode', 'autoResumeMinutes', 'budgetCap', 'lastSeenTs'].forEach((k) => {
      if (patch[k] !== undefined) this.settings[k] = patch[k];
    });
    if (this.settings.mode !== 'supervised' && this.settings.mode !== 'full') this.settings.mode = 'supervised';
    this._saveSettings();
    if (!prevOn && this.settings.autopilotOn) {
      this.runlog.add('autopilot.on', {});
      this.tick();
    } else if (prevOn && !this.settings.autopilotOn) {
      this.runlog.add('autopilot.off', {});
    }
    return this.getState();
  }

  // ---------- queue API (IPC) ----------
  addMission(folderId, goal) {
    const res = this.missions.add(folderId, goal);
    if (res.ok) {
      this.runlog.add('mission.queued', { folderId, missionId: res.mission.id, data: { goal: res.mission.goal } });
      this.tick();
    }
    return res;
  }
  removeMission(id) { return this.missions.remove(id); }
  listMissions(folderId) { return this.missions.list(folderId); }

  // blocked → queued (user says "try again"); prerequisites are re-validated on dispatch
  retryMission(id) {
    const m = this.missions.get(id);
    if (!m) return { ok: false, error: 'no such mission' };
    if (m.status !== 'blocked' && m.status !== 'rolled_back') return { ok: false, error: 'only blocked/rolled back missions can be retried' };
    this.missions.setStatus(id, 'queued', { blockReason: null, assigneeHead: null, startedAt: null, finishedAt: null });
    this.runlog.add('mission.queued', { folderId: m.folderId, missionId: id, data: { goal: m.goal, retry: true } });
    this.tick();
    return { ok: true };
  }

  cancelMission(id) {
    const m = this.missions.get(id);
    if (!m) return { ok: false, error: 'no such mission' };
    if (['done', 'blocked', 'rolled_back'].indexOf(m.status) !== -1) return { ok: false, error: 'mission already finished' };
    if (m.status === 'running' && m.assigneeHead) {
      this.router.route('autopilot', m.assigneeHead, '[MISSION CANCELLED] Stop work on the current mission: ' + m.goal, true);
    }
    this.missions.setStatus(id, 'blocked', { blockReason: 'cancelled by user' });
    this.runlog.add('mission.blocked', { folderId: m.folderId, missionId: id, data: { reason: 'cancelled by user' } });
    return { ok: true };
  }

  // Stall detector (F6): the bus reports every pane POST; a running mission
  // whose folder goes silent for 10 minutes gets ONE runlog warning per window.
  noteBusActivity(paneId) {
    const pane = this.pty.get(paneId);
    if (pane && pane.folderId) this.lastBusTs[pane.folderId] = Date.now();
  }

  // Running mission goal, for `mesh mission show` (F7).
  missionFor(paneId) {
    const pane = this.pty.get(paneId);
    if (!pane) return null;
    return this.missions.activeFor(pane.folderId);
  }

  // ---------- the loop ----------
  tick() {
    if (!this.settings.autopilotOn) return;
    if (this.guard.stats().paused) return; // paused mesh = paused autopilot
    // stall warnings (running missions in silent folders)
    const now = Date.now();
    for (const m of this.missions.list()) {
      if (m.status !== 'running') continue;
      const last = this.lastBusTs[m.folderId] || m.startedAt || now;
      const warned = this.stallWarned[m.folderId] || 0;
      if (now - last > 600000 && now - warned > 600000) {
        this.stallWarned[m.folderId] = now;
        this.runlog.add('mission.stall', { folderId: m.folderId, missionId: m.id, data: { silentMinutes: Math.round((now - last) / 60000) } });
      }
    }
    for (const folder of this.folders.values()) {
      const next = this.missions.nextFor(folder.id);
      if (!next) continue;
      const check = this._validateTopology(folder.id);
      if (!check.ok) {
        this.missions.setStatus(next.id, 'blocked', { blockReason: check.error });
        this.runlog.add('mission.blocked', { folderId: folder.id, missionId: next.id, data: { reason: check.error } });
        continue;
      }
      this._startMission(next, check.headId);
    }
  }

  _validateTopology(folderId) {
    const agents = this.pty.list().filter((a) => a.folderId === folderId);
    const heads = agents.filter((a) => a.role === 'head');
    if (!heads.length) return { ok: false, error: 'no HEAD terminal in this folder' };
    // Open mesh: everyone in the folder can already talk both directions.
    if (this.router.openMesh) return { ok: true, headId: heads[0].id };
    const wires = this.router.listWires();
    // pick the first HEAD that can send to someone AND has someone wired back
    for (const h of heads) {
      const canSend = wires.some((w) => w.from === h.id && agents.some((a) => a.id === w.to));
      const canReceive = wires.some((w) => w.to === h.id && agents.some((a) => a.id === w.from));
      if (canSend && canReceive) return { ok: true, headId: h.id };
      if (canSend && agents.length === 1) return { ok: true, headId: h.id }; // solo HEAD folder
    }
    if (agents.length === 1) return { ok: true, headId: heads[0].id }; // HEAD works alone
    return { ok: false, error: 'HEAD is not wired both directions to any worker (use "Connect both directions")' };
  }

  _protocolText() {
    return 'This is an Autopilot mission. Plan and delegate to the terminals you can SEND to. ' +
      'Workers commit in their worktrees. When the mission is complete, run: mesh mission done "<one-line summary>". ' +
      'If you cannot proceed, run: mesh mission blocked "<reason>". ' +
      'Do NOT merge branches yourself — merging is handled by the review gate.';
  }

  _startMission(mission, headId) {
    this.missions.setStatus(mission.id, 'running', { assigneeHead: headId });
    this.runlog.add('mission.started', { folderId: mission.folderId, missionId: mission.id, data: { head: headId, goal: mission.goal } });
    const text = '[GOAL] ' + mission.goal + '\n\n' + this._protocolText();
    const r = this.router.route('autopilot', headId, text, true);
    if (!r.ok) {
      this.missions.setStatus(mission.id, 'blocked', { blockReason: 'could not reach HEAD: ' + (r.error || 'route failed') });
      this.runlog.add('mission.blocked', { folderId: mission.folderId, missionId: mission.id, data: { reason: r.error } });
    }
  }

  // ---------- completion contract (bus → here) ----------
  _runningFor(senderId) {
    const pane = this.pty.get(senderId);
    if (!pane) return { error: 'unknown sender' };
    const mission = this.missions.activeFor(pane.folderId);
    if (!mission || mission.status !== 'running') return { error: 'no running mission in your folder' };
    if (mission.assigneeHead !== senderId) return { error: 'only the assigned HEAD (' + mission.assigneeHead + ') may report this mission' };
    return { mission, pane };
  }

  missionDone(senderId, summary) {
    const r = this._runningFor(senderId);
    if (r.error) return { ok: false, error: r.error };
    const mission = r.mission;
    const folder = this.folders.get(mission.folderId);
    return this._resolveDone(mission, folder, summary).then((out) => out).catch((e) => {
      this.missions.setStatus(mission.id, 'blocked', { blockReason: 'resolve failed: ' + e.message });
      return { ok: false, error: e.message };
    });
  }

  async _resolveDone(mission, folder, summary) {
    // Candidate branches = this folder's worktrees with committed changes.
    const branches = [];
    if (folder && folder.wtm && folder.isGit) {
      for (const w of folder.wtm.list()) {
        try {
          const d = await folder.wtm.diff(w.id);
          if (d.patch && d.patch.trim()) branches.push({ agentId: w.id, branch: d.branch, dirty: d.dirty });
        } catch (_) { /* worktree may be gone */ }
      }
    }
    if (!branches.length) {
      this.missions.setStatus(mission.id, 'done', { summary: summary || null });
      this.runlog.add('mission.done', { folderId: mission.folderId, missionId: mission.id, data: { summary, merges: 0 } });
      this.tick(); // advance the queue
      return { ok: true, status: 'done' };
    }
    this.missions.setStatus(mission.id, 'awaiting_review', { summary: summary || null, branches });
    this.runlog.add('mission.review', { folderId: mission.folderId, missionId: mission.id, data: { summary, branches: branches.map((b) => b.branch) } });
    if (this.settings.mode === 'full') {
      // B3: the Merge Officer takes it from here.
      this._officerPass(mission.id).catch((e) => console.log(`[autopilot] officer error: ${e.message}`));
    }
    return { ok: true, status: 'awaiting_review', branches: branches.length };
  }

  missionBlocked(senderId, reason) {
    const r = this._runningFor(senderId);
    if (r.error) return { ok: false, error: r.error };
    this.missions.setStatus(r.mission.id, 'blocked', { blockReason: reason || 'blocked by HEAD' });
    this.runlog.add('mission.blocked', { folderId: r.mission.folderId, missionId: r.mission.id, data: { reason } });
    return { ok: true };
  }

  // ---------- B2: approve / request changes / rollback ------------------------
  // Merging happens HERE at the folder repo root — never inside an agent's
  // worktree terminal. A checkpoint (sha + tag) is recorded before the first
  // merge of a mission so it can always be rolled back.
  async approveMission(missionId, _lockHeld) {
    const mission = this.missions.get(missionId);
    if (!mission) return { ok: false, error: 'no such mission' };
    if (mission.status !== 'awaiting_review') return { ok: false, error: 'mission is not awaiting review' };
    const folder = this.folders.get(mission.folderId);
    if (!folder || !folder.wtm || !folder.isGit) return { ok: false, error: 'folder repo unavailable' };
    if (!_lockHeld) {
      if (this.mergeLocks[mission.folderId]) return { ok: false, error: 'a merge is already in progress for this folder' };
      this.mergeLocks[mission.folderId] = true;
    }
    this.missions.setStatus(missionId, 'merging');
    try {
      // repo root must be clean before we touch it
      const dirty = (await git(folder.repo, ['status', '--porcelain'])).trim();
      if (dirty) throw new Error('repo root has uncommitted changes');
      // checkpoint before the first merge
      const sha = (await git(folder.repo, ['rev-parse', 'HEAD'])).trim();
      const tag = 'am-cp-' + missionId;
      await git(folder.repo, ['tag', '-f', tag, sha]);
      this.missions.setStatus(missionId, 'merging', { checkpoint: { sha, tag } });
      this.runlog.add('mission.checkpoint', { folderId: mission.folderId, missionId, data: { sha, tag } });

      const mergeCommits = [];
      for (const b of mission.branches || []) {
        if (b.dirty) {
          this.runlog.add('mission.merge_skipped', { folderId: mission.folderId, missionId, data: { branch: b.branch, reason: 'uncommitted changes in worktree' } });
          continue;
        }
        try {
          // Merge by BRANCH NAME at the repo root — branches persist across
          // restarts while the WorktreeManager's in-memory map does not, so an
          // awaiting_review mission stays approvable after the app restarts.
          await git(folder.repo, ['merge', '--no-ff', '-m', 'merge ' + b.branch + ' (' + missionId + ')', b.branch]);
        } catch (e) {
          await git(folder.repo, ['merge', '--abort']).catch(() => {});
          this.missions.setStatus(missionId, 'blocked', { blockReason: 'merge conflict on ' + b.branch + ': ' + e.message });
          this.runlog.add('mission.blocked', { folderId: mission.folderId, missionId, data: { reason: 'merge conflict on ' + b.branch } });
          return { ok: false, error: 'merge conflict on ' + b.branch, conflict: true };
        }
        const mc = (await git(folder.repo, ['rev-parse', 'HEAD'])).trim();
        mergeCommits.push(mc);
        this.runlog.add('mission.merged', { folderId: mission.folderId, missionId, data: { branch: b.branch, commit: mc } });
      }
      this.missions.setStatus(missionId, 'done', { mergeCommits });
      this.runlog.add('mission.done', { folderId: mission.folderId, missionId, data: { summary: mission.summary, merges: mergeCommits.length } });
      this.tick(); // advance to the next queued mission
      return { ok: true, merged: mergeCommits.length };
    } catch (e) {
      this.missions.setStatus(missionId, 'blocked', { blockReason: e.message });
      this.runlog.add('mission.blocked', { folderId: mission.folderId, missionId, data: { reason: e.message } });
      return { ok: false, error: e.message };
    } finally {
      if (!_lockHeld) this.mergeLocks[mission.folderId] = false;
    }
  }

  async requestChanges(missionId, comment) {
    const mission = this.missions.get(missionId);
    if (!mission) return { ok: false, error: 'no such mission' };
    if (mission.status !== 'awaiting_review') return { ok: false, error: 'mission is not awaiting review' };
    const text = '[REVIEW] Change request on mission ' + missionId + ': ' + (comment || '(no detail)');
    const targets = (mission.branches || []).map((b) => b.agentId);
    if (mission.assigneeHead && targets.indexOf(mission.assigneeHead) === -1) targets.push(mission.assigneeHead);
    targets.forEach((t) => this.router.route('autopilot', t, text, true));
    // hand the mission back to the HEAD as running so the loop can finish it again
    this.missions.setStatus(missionId, 'running');
    this.runlog.add('mission.changes_requested', { folderId: mission.folderId, missionId, data: { comment } });
    return { ok: true };
  }

  async rollbackMission(missionId) {
    const mission = this.missions.get(missionId);
    if (!mission) return { ok: false, error: 'no such mission' };
    if (mission.status !== 'done' || !(mission.mergeCommits || []).length) {
      return { ok: false, error: 'nothing to roll back' };
    }
    const folder = this.folders.get(mission.folderId);
    if (!folder || !folder.isGit) return { ok: false, error: 'folder repo unavailable' };
    if (this.mergeLocks[mission.folderId]) return { ok: false, error: 'a merge is in progress for this folder' };
    this.mergeLocks[mission.folderId] = true;
    try {
      const dirty = (await git(folder.repo, ['status', '--porcelain'])).trim();
      if (dirty) throw new Error('repo root has uncommitted changes');
      // revert newest merge first — non-destructive (history preserved)
      for (const mc of mission.mergeCommits.slice().reverse()) {
        await git(folder.repo, ['revert', '-m', '1', '--no-edit', mc]);
      }
      this.missions.setStatus(missionId, 'rolled_back');
      this.runlog.add('mission.rolledback', { folderId: mission.folderId, missionId, data: { commits: mission.mergeCommits } });
      return { ok: true };
    } catch (e) {
      await git(folder.repo, ['revert', '--abort']).catch(() => {});
      return { ok: false, error: e.message };
    } finally {
      this.mergeLocks[mission.folderId] = false;
    }
  }

  // ---------- B3: the Merge Officer (Full Auto) --------------------------------
  // One headless `claude -p` pass over the mission's diffs. The contract is a
  // single verdict line: `MERGE` or `HOLD: <reason>`. Anything else — timeout,
  // spawn failure, unparseable output — falls back to human review (safe).
  async _officerPass(missionId) {
    const mission = this.missions.get(missionId);
    if (!mission || mission.status !== 'awaiting_review') return;
    const folder = this.folders.get(mission.folderId);
    if (!folder || !folder.wtm || this.mergeLocks[mission.folderId]) return;
    // Hold the folder's merge lock for the WHOLE pass (diff read → verdict →
    // merge), not just the approve step — otherwise a human direct-merge could
    // interleave during the officer's (up to 120s) judgment window.
    this.mergeLocks[mission.folderId] = true;
    try {
      await this._officerPassLocked(mission, folder);
    } finally {
      this.mergeLocks[mission.folderId] = false;
    }
  }

  async _officerPassLocked(mission, folder) {
    const missionId = mission.id;
    let diffs = '';
    const base = (folder.wtm && folder.wtm.baseBranch) || 'HEAD';
    for (const b of mission.branches || []) {
      try {
        // Branch-based diff (restart-proof; independent of the in-memory worktree map)
        const range = base + '...' + b.branch;
        const stat = await git(folder.repo, ['diff', '--stat', range]);
        const patch = await git(folder.repo, ['diff', range]);
        diffs += '===== branch ' + b.branch + ' =====\n' + stat.trim() + '\n' + String(patch || '').slice(0, 60000) + '\n\n';
      } catch (e) { diffs += '===== branch ' + b.branch + ' ===== (diff unavailable: ' + e.message + ')\n'; }
    }
    const prompt = [
      'You are the Merge Officer for an autonomous coding run.',
      'Mission goal: ' + mission.goal,
      'HEAD summary: ' + (mission.summary || '(none)'),
      '',
      'Below are the committed diffs (branch vs main) that would be merged to main.',
      'Judge ONLY: does the change plausibly satisfy the goal, is it coherent, and is there',
      'anything dangerous or clearly broken (secrets, deleted unrelated code, syntax garbage)?',
      '',
      diffs,
      'Reply with EXACTLY ONE final line and nothing after it:',
      'MERGE',
      'or',
      'HOLD: <short reason>',
    ].join('\n');

    const out = await this._runOfficer(prompt);
    if (out.costUsd != null) this.emit('officerCost', { usd: out.costUsd, tokens: out.tokens || 0 });
    if (out.error) {
      this.runlog.add('officer.verdict', { folderId: mission.folderId, missionId, data: { verdict: 'HOLD', reason: 'officer failed: ' + out.error, fallback: true } });
      return; // stays awaiting_review → human
    }
    // The contract is "EXACTLY ONE final line" — so judge ONLY the last
    // non-empty line. Scanning the whole blob would let a `MERGE` line inside
    // an echoed diff (or a worker's own committed code) force an auto-merge.
    const lines = String(out.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const last = lines.length ? lines[lines.length - 1] : '';
    const holdMatch = /^HOLD\s*:?\s*(.*)$/i.exec(last);
    if (/^MERGE$/i.test(last)) {
      this.runlog.add('officer.verdict', { folderId: mission.folderId, missionId, data: { verdict: 'MERGE' } });
      await this.approveMission(missionId, true); // lock is already held by the pass
    } else {
      const reason = holdMatch ? (holdMatch[1] || '').trim() : 'no clear verdict';
      this.runlog.add('officer.verdict', { folderId: mission.folderId, missionId, data: { verdict: 'HOLD', reason } });
      // stays awaiting_review — surfaces as needs-you in the digest
    }
  }

  _runOfficer(prompt) {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      let child;
      try {
        // `claude` is a .cmd shim on Windows — shell:true launches it portably.
        // The prompt travels via stdin so no shell-quoting is involved. JSON
        // output carries the verdict text plus REAL usage/cost for the pass.
        // detached (POSIX) makes the child a process-group leader so a timeout
        // can kill the WHOLE tree — otherwise child.kill() reaps only the shell
        // and leaves the real `claude` grandchild running.
        child = spawn('claude -p --output-format json', {
          shell: true, windowsHide: true, detached: process.platform !== 'win32',
        });
      } catch (e) { return resolve({ error: e.message }); }
      let out = '', err = '';
      let done = false;
      const finish = (res) => { if (!done) { done = true; resolve(res); } };
      const timer = setTimeout(() => {
        killTree(child);
        finish({ error: 'timeout after 120s' });
      }, 120000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); finish({ error: e.message }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !out.trim()) return finish({ error: 'exit ' + code + ': ' + err.slice(0, 200) });
        try {
          const j = JSON.parse(out);
          const usage = j.usage || {};
          finish({
            text: String(j.result || ''),
            costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
            tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          });
        } catch (_) {
          finish({ text: out }); // non-JSON output still parses for MERGE/HOLD
        }
      });
      try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { clearTimeout(timer); finish({ error: e.message }); }
    });
  }

  // ---------- watchdog + guard policy ----------
  _onAgentExit(agentId, exitCode) {
    // The pane record is already gone; block any running mission that depended
    // on this agent (its assigned HEAD, or a worker whose branch it owns).
    for (const m of this.missions.list()) {
      if (m.status !== 'running' && m.status !== 'awaiting_review') continue;
      const involved = m.assigneeHead === agentId || (m.branches || []).some((b) => b.agentId === agentId);
      if (!involved) continue;
      if (m.status === 'running') {
        const reason = 'agent ' + agentId + ' exited (code ' + exitCode + ')';
        this.missions.setStatus(m.id, 'blocked', { blockReason: reason });
        this.runlog.add('mission.blocked', { folderId: m.folderId, missionId: m.id, data: { reason } });
      }
      this.runlog.add('watchdog.agent_exit', { folderId: m.folderId, missionId: m.id, data: { agentId, exitCode } });
    }
  }

  _onGuardPaused(reason) {
    this.runlog.add('guard.paused', { data: { reason } });
    const mins = this.settings.autoResumeMinutes;
    if (!this.settings.autopilotOn || !mins || /stopped by user|autopilot/i.test(String(reason))) return;
    // auto-resume policy: at most 2 auto-resumes per rolling hour
    const now = Date.now();
    this.resumeCount = this.resumeCount.filter((t) => now - t < 3600000);
    if (this.resumeCount.length >= 2) {
      this.runlog.add('guard.autoresume_skipped', { data: { reason: 'retry budget exhausted' } });
      return;
    }
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      if (!this.guard.stats().paused) return;
      this.resumeCount.push(Date.now());
      this.guard.resume();
      this.runlog.add('guard.autoresumed', { data: { afterMinutes: mins } });
      this.tick();
    }, mins * 60000);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.resumeTimer);
  }
}

module.exports = { AutopilotEngine };
