# Changelog

## 0.2.0 — 2026-07-22

- Auto-update on Windows and macOS via GitHub Releases (electron-updater).
  The status bar shows real download progress; a restart chip appears once the
  update is verified on disk, and a downloaded update also applies on normal quit.
- macOS builds are now code-signed (Developer ID, hardened runtime) and
  notarized when notary credentials are present at build time.
- macOS now also produces a `.zip` artifact — required by the macOS updater;
  the `.dmg` remains the first-install download.

## 0.1.0

- First packaged release: Windows NSIS installer + macOS dmg (unsigned).
