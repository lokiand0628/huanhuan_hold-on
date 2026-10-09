# Version Update Guide

This document lists all the locations where the application version number needs to be updated when releasing a new version.

## Version Number Policy

缓缓 (Hold On) follows semantic versioning:

| Version Part | Use When |
|--------------|----------|
| `MAJOR` | A release changes data/config compatibility or drops platform support. |
| `MINOR` | A release adds user-facing features, such as a new reminder mode. |
| `PATCH` | A release fixes bugs, improves reliability, updates release tooling, or polishes existing behavior. |

Documentation-only changes do not need a version bump or release tag.

Never reuse an existing tag. If `v0.0.1` has a problem after release, fix it and publish `v0.0.2`.

## Recommended Release Flow

1. Decide whether the change is `MAJOR`, `MINOR`, or `PATCH`.
2. Update the version files below.
3. Update the `README.md` and `README.en.md` changelog entries.
4. Run `npm run build`.
5. Run `cd src-tauri && cargo check` and `cd src-tauri && cargo test`.
6. Commit the release prep changes.
7. Tag the release with `vX.Y.Z` and push the tag.
8. After GitHub Actions finishes, verify the GitHub Release assets contain the
   `aarch64` dmg.

## Configuration Files

| File Path | Location / Key | Description |
|-----------|---------------|-------------|
| `package.json` | `version` | Main Node.js project version. |
| `src-tauri/tauri.conf.json` | `version` | Tauri application version (used for build artifacts). |
| `src-tauri/Cargo.toml` | `version` | Rust crate version. |

The app reads its own version at runtime from Tauri's app metadata
(`getVersion()`), so there is no version string to keep in sync inside the
frontend source.

## Lock Files (Auto-generated)

| File Path | Command to Update | Description |
|-----------|-------------------|-------------|
| `package-lock.json` | `npm install` | Updates after `package.json` change. |
| `src-tauri/Cargo.lock` | `cargo check` (in `src-tauri/`) | Updates after `Cargo.toml` change. |

> Do not run a bare `cargo update` to refresh `Cargo.lock`. It upgrades the whole
> dependency tree, Tauri included, in one step — far more than a version bump needs.

## Documentation

| File Path | Location | Description |
|-----------|----------|-------------|
| `README.md` | Badge URL (`shields.io`)<br>`## 版本记录` (Changelog) | Chinese README version badge and history. |
| `README.en.md` | Badge URL (`shields.io`)<br>`## Version history` (Changelog) | English README version badge and history. |
| `docs/screenshots/` | Feature screenshots used by README files | Add or refresh screenshots for user-facing changes. |

## Update Checklist

1. [ ] Update `package.json`.
2. [ ] Update `src-tauri/tauri.conf.json`.
3. [ ] Update `src-tauri/Cargo.toml`.
4. [ ] Update the `README.md` and `README.en.md` badges, screenshots and changelog.
5. [ ] Run `npm install` to update `package-lock.json`.
6. [ ] Run `cd src-tauri && cargo check` to update `Cargo.lock`.
7. [ ] Run `npm run build` to verify the frontend builds.
8. [ ] Run `cd src-tauri && cargo test` when backend logic changed.
