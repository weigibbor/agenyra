# Contributing to Agenyra

Thanks for wanting to help! Ideas, bug reports, and pull requests are all welcome.

## Ways to contribute

- **💬 [Discussions](https://github.com/weigibbor/agenyra/discussions)** — suggest features, ask questions, share how you use Agenyra.
- **🐛 [Issues](https://github.com/weigibbor/agenyra/issues)** — report bugs (the template asks for repro steps).
- **🔀 Pull requests** — fixes and features. For anything big, open a Discussion or Issue first so we agree on the direction before you invest time.

## Getting started

```sh
git clone https://github.com/weigibbor/agenyra.git
cd agenyra
npm install
npm start        # launch the app
```

## Before you open a PR

1. **Run the test suites** — all must stay green:
   ```sh
   npm test                  # smoke: bus, routing, security gate, CLI end-to-end
   node test/guard.js
   node test/worktree.js
   node test/autopilot.js
   node test/session.js
   ```
2. **Match the codebase style** — plain JavaScript (no TypeScript, no build step), vanilla-JS renderer, 2-space indent. Match the comment density and naming around your change.
3. **No new dependencies** without discussing first — the dependency surface is deliberately tiny (Electron, xterm, node-pty).
4. **Keep the security model intact** — the bus must stay loopback-only and token-gated; the renderer stays sandboxed behind the preload bridge (`contextIsolation: true`, no `nodeIntegration`).
5. **Small, focused PRs** review faster than big ones.

## Project layout

```
main.js              Electron main entry (window, IPC, boot)
preload.js           contextBridge API (renderer <-> main)
main/                bus, router, pty, coordinator, worktrees, autopilot, cost, sessions
renderer/            vanilla-JS UI (chats, code workbench, mesh canvas, autopilot)
bin/mesh(.js/.cmd)   the `mesh` CLI injected into every pane
test/                deterministic test suites
```

## License

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
