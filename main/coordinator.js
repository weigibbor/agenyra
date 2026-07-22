'use strict';
const { EventEmitter } = require('events');

let taskSeq = 1;

// The deterministic coordination layer — CODE, not AI. Handles the task board
// (atomic claim), resource locks (mutual exclusion), announcements (pub/sub),
// and live progress (checklist steps + activity + location). Because Node is
// single-threaded, claims and lock grants are inherently atomic — no two agents
// ever grab the same task or lock.
class Coordinator extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map(); // id -> task
    this.locks = new Map(); // resource -> { holder, since, waiters: [] }
    this.announcements = []; // { from, message, at }
  }

  // ---- Task board ---------------------------------------------------------
  addTask(title, steps = []) {
    const id = `T${taskSeq++}`;
    const task = {
      id,
      title,
      assignee: null,
      status: 'todo', // todo | in_progress | review | done
      steps: steps.map((label) => ({ label, status: 'pending' })), // pending | active | done
      activity: null,
      location: null,
      at: Date.now(),
    };
    this.tasks.set(id, task);
    this._changed();
    return task;
  }

  // Atomic: returns the next TODO task and assigns it to the agent.
  claimTask(agent) {
    for (const task of this.tasks.values()) {
      if (task.status === 'todo') {
        task.status = 'in_progress';
        task.assignee = agent;
        this._changed();
        return task;
      }
    }
    return null;
  }

  doneTask(agent, id) {
    const task = this.tasks.get(id);
    if (!task) return { ok: false, error: `no task ${id}` };
    task.status = 'done';
    task.steps.forEach((s) => (s.status = 'done'));
    this._pruneDone();
    this._changed();
    return { ok: true, task };
  }

  // Keep the task board bounded over a long session: drop the oldest DONE tasks
  // (they're history) once they pile up. Active/review/todo tasks are never
  // evicted. This also bounds the snapshot broadcast on every change.
  _pruneDone() {
    const DONE_CAP = 100;
    const done = [...this.tasks.values()].filter((t) => t.status === 'done').sort((a, b) => a.at - b.at);
    for (let i = 0; i < done.length - DONE_CAP; i++) this.tasks.delete(done[i].id);
  }

  reviewTask(agent, id) {
    const task = this.tasks.get(id);
    if (!task) return { ok: false, error: `no task ${id}` };
    task.status = 'review';
    this._changed();
    return { ok: true, task };
  }

  listTasks() {
    return [...this.tasks.values()];
  }

  _activeTaskFor(agent) {
    for (const task of this.tasks.values()) {
      if (task.assignee === agent && task.status === 'in_progress') return task;
    }
    return null;
  }

  // ---- Live progress ------------------------------------------------------
  addStep(agent, label) {
    const task = this._activeTaskFor(agent);
    if (!task) return { ok: false, error: 'no active task' };
    task.steps.push({ label, status: 'pending' });
    this._changed();
    return { ok: true };
  }

  startStep(agent, label) {
    const task = this._activeTaskFor(agent);
    if (!task) return { ok: false, error: 'no active task' };
    for (const s of task.steps) if (s.status === 'active') s.status = 'pending';
    const step = task.steps.find((s) => s.label === label);
    if (step) step.status = 'active';
    this._changed();
    return { ok: true };
  }

  doneStep(agent, label) {
    const task = this._activeTaskFor(agent);
    if (!task) return { ok: false, error: 'no active task' };
    const step = task.steps.find((s) => s.label === label);
    if (step) step.status = 'done';
    this._changed();
    return { ok: true };
  }

  setActivity(agent, activity) {
    const task = this._activeTaskFor(agent);
    if (task) {
      task.activity = activity;
      this._changed();
    }
    return { ok: true };
  }

  setLocation(agent, location) {
    const task = this._activeTaskFor(agent);
    if (task) {
      task.location = location;
      this._changed();
    }
    return { ok: true };
  }

  // ---- Resource locks -----------------------------------------------------
  acquireLock(agent, resource) {
    const lock = this.locks.get(resource);
    if (!lock) {
      this.locks.set(resource, { holder: agent, since: Date.now(), waiters: [] });
      this._changed();
      return { ok: true, held: true, holder: agent };
    }
    if (lock.holder === agent) return { ok: true, held: true, holder: agent };
    if (!lock.waiters.includes(agent)) lock.waiters.push(agent);
    this._changed();
    return { ok: false, held: false, holder: lock.holder, waiting: true };
  }

  releaseLock(agent, resource) {
    const lock = this.locks.get(resource);
    if (!lock) return { ok: false, error: 'no such lock' };
    if (lock.holder !== agent) return { ok: false, error: 'not the holder' };
    const next = lock.waiters.shift();
    if (next) {
      lock.holder = next;
      lock.since = Date.now();
      this._changed();
      return { ok: true, grantedTo: next };
    }
    this.locks.delete(resource);
    this._changed();
    return { ok: true, grantedTo: null };
  }

  listLocks() {
    return [...this.locks.entries()].map(([resource, l]) => ({
      resource,
      holder: l.holder,
      since: l.since,
      waiters: [...l.waiters],
    }));
  }

  // ---- Announcements ------------------------------------------------------
  announce(from, message) {
    const entry = { from, message, at: Date.now() };
    this.announcements.push(entry);
    if (this.announcements.length > 200) this.announcements.shift(); // bound unbounded growth
    this.emit('announce', entry);
    this._changed();
    return { ok: true };
  }

  snapshot() {
    return {
      tasks: this.listTasks(),
      locks: this.listLocks(),
      announcements: this.announcements.slice(-50),
    };
  }

  _changed() {
    this.emit('change', this.snapshot());
  }
}

module.exports = { Coordinator };
