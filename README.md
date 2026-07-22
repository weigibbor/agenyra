# Agent Mesh

Wired multi-agent terminal orchestrator. Maraming AI CLI agent sa live terminal
panes na nag-uusap via message bus, may **HEAD** na nag-o-orchestrate. Local,
black theme, Windows + macOS. Buong plano: [`ARCHITECTURE.md`](./ARCHITECTURE.md).
UI/UX brief para kay Claude design: [`DESIGN_BRIEF.md`](./DESIGN_BRIEF.md).

## Structure

```
main.js              Electron main entry (window, IPC, boot)
preload.js           contextBridge API (renderer <-> main)
main/
  pty.js             PTY manager (node-pty spawn per pane)
  bus.js             Local HTTP message bus (127.0.0.1)
  router.js          Message routing + wire enforcement
  coordinator.js     Task board + locks + announcements + live progress (CODE)
  worktree.js        git worktree per worker (isolation)
renderer/            Dev-harness UI (temporary — real design pending)
bin/mesh(.js/.cmd)   The `mesh` CLI every agent uses to talk to the mesh
```

## Setup

```sh
npm install          # installs Electron + xterm + node-pty
npm run rebuild      # rebuild node-pty against Electron's ABI (if needed)
npm start            # launch the app
```

> **node-pty is a native module.** If `npm start` errors with an ABI/version
> mismatch, run `npm run rebuild`. On Windows this needs Visual Studio Build
> Tools + Python; on macOS, Xcode command-line tools.

## The `mesh` CLI (used inside each pane)

```sh
mesh send <pane> "<msg>"     # message another pane
mesh announce "<msg>"        # broadcast a heads-up
mesh task add "<title>"      # add a task to the board
mesh task claim              # claim the next TODO (atomic)
mesh task done <id>          # finish a task
mesh step add|start|done "<label>"   # live checklist
mesh status "<activity>"     # current activity line
mesh at "<file/dir>"         # where you are in the code
mesh lock acquire|release <resource> # shared-resource mutex
```

Status: backend scaffold + dev harness done. Next: validate `node-pty` build,
then swap in the real UI once the mockup lands.
