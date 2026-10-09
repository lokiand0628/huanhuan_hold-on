# Contributing

Thanks for helping improve 缓缓 (Hold On). To keep maintenance predictable, please keep pull requests focused and easy to verify.

## Pull Request Scope

- Keep one pull request focused on one behavior change.
- Do not include unrelated formatting, lockfile, generated-file, or dependency churn.
- If a lockfile changes, explain which dependency command caused it.
- Include the user-facing impact and the tests you ran.

## Testing Expectations

Use the smallest test set that matches the change:

- Frontend or UI changes: run `npm run build`.
- Rust backend changes: run `cd src-tauri && cargo check`.
- Scheduler, pause, idle, or lock-screen changes: run `cd src-tauri && cargo test`.
- Release workflow changes: verify the workflow produces a `aarch64` dmg.

Also mention any manual checks that matter — forced lock-screen behavior, the emergency
gate, the centered popup, custom sounds, custom lock-screen backgrounds, and rest-duration
authentication all need a real packaged build, not just the browser mock.

## Two Things That Are Easy To Break

**Enforcement must not be weakened.** The lock screen is the product. Anything that adds an
exit — a new keybinding, a tray item, a timeout that unlocks instead of escalating — is a
regression even if it looks like a convenience. If a change touches `ExitRequested`, the
tray quit/restart paths, the lock watchdog, or `lock.json`, say so explicitly in the PR.

**The rest-duration gate has exactly one choke point.** Every path that changes
`lockDuration` must go through `applyDuration` in `src/core/actions.js`. Adding a second
place that writes `task.lockDuration` directly bypasses the Touch ID check.

## Tauri Security Notes

Be careful with Content Security Policy changes. The app uses Tauri APIs and local asset loading:

- `convertFileSrc(...)` requires the CSP to allow `asset:` and `http://asset.localhost` for image/media sources.
- Tauri IPC may require `ipc:` and `http://ipc.localhost`.
- Custom lock-screen backgrounds depend on local asset loading.

A CSP change that only allows `'self'` can look safer but still break existing desktop features.

## Versioning Policy

缓缓 uses semantic versioning:

- `MAJOR` for incompatible config/data or platform changes.
- `MINOR` for user-facing features.
- `PATCH` for bug fixes, reliability fixes, release fixes, and small polish.

Documentation-only changes do not need a new app version or release tag. Never reuse an existing release tag; if a released build is wrong, publish a new patch version.

Before tagging a release, update the version files listed in `docs/VERSION_GUIDE.md`, update the changelog, run the relevant checks, and verify the release artifacts after GitHub Actions finishes.
