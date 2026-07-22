# Agenyra

**Multi-agent terminal orchestrator.** Run many AI CLI agents (Claude Code, Codex, Grok, Aider — or plain shells) in live terminal panes, wire them together on an infinite mesh canvas, and let a **HEAD** agent orchestrate the work. Everything runs locally. Windows + macOS.

https://agenyra.com

## Highlights

- **Live mesh canvas** — an infinite pan/zoom world of terminal nodes. Drag wires between agents to define who can talk to whom; promote any terminal to HEAD (multiple HEADs supported).
- **Real agents, real terminals** — every pane is a genuine PTY running the actual CLI. Chat lens on top when you want a conversation view, raw terminal when you don't.
- **Token-secured local bus** — agents talk through a loopback HTTP bus locked with a per-session token; no cloud, nothing leaves your machine.
- **Worktree isolation** — each worker gets its own git worktree; review diffs and approve merges from the app.
- **Autopilot** — mission queue, watchdog, guardrails (exchange caps, loop detection, budget cap), and a morning digest of what happened while you were away.
- **Cost tracking** — best-effort token/spend estimates per agent with a session budget cap.

## The `mesh` CLI (available inside every pane)

```sh
mesh send <pane> "<msg>"              # message another pane
mesh announce "<msg>"                 # broadcast a heads-up
mesh task add|claim|done|review|list  # shared task board
mesh step add|start|done "<label>"    # live checklist
mesh status "<activity>"              # current activity line
mesh at "<file/dir>"                  # where you are in the code
mesh lock acquire|release <resource>  # shared-resource mutex
mesh mission done|blocked             # report the active mission (HEAD)
```

## Develop

```sh
npm install     # Electron + xterm + node-pty
npm start       # launch the app
npm test        # smoke suite (bus, routing, security gate, CLI end-to-end)
```

More suites: `node test/guard.js`, `node test/worktree.js`, `node test/autopilot.js`, `node test/session.js`.

## Build

```sh
npm run dist        # Windows NSIS installer (dist/)
npm run dist:mac    # macOS dmg — run on macOS, or use the Build macOS GitHub Action
```

## Structure

```
main.js              Electron main entry (window, IPC, boot)
preload.js           contextBridge API (renderer <-> main)
main/                bus, router, pty, coordinator, worktrees, autopilot, cost, sessions
renderer/            vanilla-JS UI (chats, code workbench, mesh canvas, autopilot)
bin/mesh(.js/.cmd)   the `mesh` CLI injected into every pane
test/                deterministic test suites
```

## License

[MIT](./LICENSE)
