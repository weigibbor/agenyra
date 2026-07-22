# Changelog

## 0.2.1 — 2026-07-22

- The running version now shows as a small `vX.Y.Z` tag next to the Agenyra
  wordmark (top-left), so you can tell at a glance which build you're on.
- Update checks, downloads, and failures are now logged to the main process
  log (offline/404/signature errors were previously invisible).

## 0.2.0 — 2026-07-22

- Auto-update on Windows and macOS via GitHub Releases (electron-updater).
  The status bar shows real download progress; a restart chip appears once the
  update is verified on disk, and a downloaded update also applies on normal quit.
- macOS builds are now code-signed (Developer ID, hardened runtime) and
  notarized by Apple — no Gatekeeper warning, no right-click-to-open.
- macOS dmg has a proper installer layout: a dark branded background with
  the app and an Applications shortcut, drag across to install.
- macOS now also produces a `.zip` artifact — required by the macOS updater;
  the `.dmg` remains the first-install download.

## 0.1.0

- First packaged release: Windows NSIS installer + macOS dmg (unsigned).
