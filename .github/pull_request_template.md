## Summary

- 

## User Impact

- 

## Validation

- [ ] `npm run build`
- [ ] `cd src-tauri && cargo check`
- [ ] `cd src-tauri && cargo test`
- [ ] Manual checks, if applicable:

## Checklist

- [ ] This PR is focused on one change.
- [ ] I did not include unrelated formatting, generated-file, lockfile, or dependency changes.
- [ ] Any lockfile change is explained in the summary.
- [ ] All user-facing text was added to `src/core/strings.js` (the app is Chinese-only; there are no locale files).
- [ ] This change does not weaken enforcement — no new exit from the lock screen, no path that unlocks on timeout.
- [ ] Any change to `lockDuration` goes through `applyDuration` in `src/core/actions.js`, so the Touch ID gate still applies.
- [ ] Tauri CSP changes preserve required app protocols such as `ipc:`, `http://ipc.localhost`, `asset:`, and `http://asset.localhost` when local assets or IPC are used.
- [ ] Version numbers are updated only when this PR is intended to create an app release.
