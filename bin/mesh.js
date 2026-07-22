#!/usr/bin/env node
'use strict';
// The `mesh` CLI — the "mouth" every agent uses to talk to the mesh. It reads
// MESH_PORT and MESH_PANE from the environment (injected per pane) and POSTs to
// the local bus. Kept dependency-free so it runs in any pane instantly.
const http = require('http');

const port = process.env.MESH_PORT;
const from = process.env.MESH_PANE || 'unknown';
const token = process.env.MESH_TOKEN || ''; // per-session bus secret (injected per pane)

if (!port) {
  console.error('mesh: MESH_PORT not set — run this inside an Agenyra terminal.');
  process.exit(1);
}

function req(method, pathname, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : '';
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Mesh-Token': token,
        },
      },
      (res) => {
        let o = '';
        res.on('data', (c) => (o += c));
        res.on('end', () => resolve({ status: res.statusCode, body: o }));
      }
    );
    r.on('error', reject);
    // If the app is alive but its event loop is wedged, don't hang the agent
    // forever — fail fast so the CLI returns control.
    r.setTimeout(5000, () => r.destroy(new Error('bus not responding')));
    if (body) r.write(body);
    r.end();
  });
}

function print(r) {
  try {
    const j = JSON.parse(r.body || '{}');
    if (j.ok === false) {
      console.error(`mesh: ${j.error || 'failed'}`);
      process.exit(1);
    }
    console.log(r.body);
  } catch (_) {
    console.log(r.body);
  }
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'send': {
        const to = sub;
        const message = rest.join(' ');
        if (!to || !message) return usage();
        return print(await req('POST', '/send', { from, to, message }));
      }
      case 'announce':
        return print(await req('POST', '/announce', { from, message: [sub, ...rest].join(' ') }));
      case 'task': {
        if (sub === 'add') return print(await req('POST', '/task/add', { from, title: rest.join(' ') }));
        if (sub === 'claim') return print(await req('POST', '/task/claim', { from }));
        if (sub === 'done') return print(await req('POST', '/task/done', { from, id: rest[0] }));
        if (sub === 'review') return print(await req('POST', '/task/review', { from, id: rest[0] }));
        if (sub === 'list' || !sub) return print(await req('GET', '/tasks'));
        return usage();
      }
      case 'step': {
        if (sub === 'add') return print(await req('POST', '/step/add', { from, label: rest.join(' ') }));
        if (sub === 'start') return print(await req('POST', '/step/start', { from, label: rest.join(' ') }));
        if (sub === 'done') return print(await req('POST', '/step/done', { from, label: rest.join(' ') }));
        return usage();
      }
      case 'status':
        return print(await req('POST', '/status', { from, activity: [sub, ...rest].join(' ') }));
      case 'at':
        return print(await req('POST', '/at', { from, location: sub }));
      case 'lock': {
        if (sub === 'acquire') return print(await req('POST', '/lock/acquire', { from, resource: rest[0] }));
        if (sub === 'release') return print(await req('POST', '/lock/release', { from, resource: rest[0] }));
        if (sub === 'status' || !sub) return print(await req('GET', '/locks'));
        return usage();
      }
      case 'mission': {
        if (sub === 'done') return print(await req('POST', '/mission/done', { from, summary: rest.join(' ') }));
        if (sub === 'blocked') return print(await req('POST', '/mission/blocked', { from, reason: rest.join(' ') }));
        if (sub === 'show') return print(await req('GET', '/mission?pane=' + encodeURIComponent(from)));
        if (sub === 'list' || !sub) return print(await req('GET', '/missions'));
        return usage();
      }
      case 'list':
        return print(await req('GET', '/panes'));
      default:
        return usage();
    }
  } catch (e) {
    console.error(`mesh: ${e.message}`);
    process.exit(1);
  }
}

function usage() {
  console.log(`Agenyra mesh CLI  (you are pane: ${from})

  mesh send <pane> "<msg>"      send a message to another pane
  mesh announce "<msg>"         broadcast a heads-up to everyone

  mesh task add "<title>"       add a task to the board
  mesh task claim               claim the next TODO task (atomic)
  mesh task done <id>           mark a task done
  mesh task review <id>         move a task to review
  mesh task list                list tasks

  mesh step add "<label>"       add a checklist step to your active task
  mesh step start "<label>"     mark a step as current (shows as the active step)
  mesh step done "<label>"      check a step off (done)
  mesh status "<activity>"      set your current activity line
  mesh at "<file/dir>"          set where you are in the code

  mesh lock acquire <res>       acquire a shared-resource lock
  mesh lock release <res>       release a shared-resource lock
  mesh lock status              show locks

  mesh mission done "<summary>"     (HEAD) report the current Autopilot mission complete
  mesh mission blocked "<reason>"   (HEAD) report the current mission cannot proceed
  mesh mission show                 show your folder's active mission goal
  mesh mission list                 list missions

  mesh list                     list live panes`);
}

main();
