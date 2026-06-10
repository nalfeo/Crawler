# Handoff: Worktree server canvas open fix

## Summary

Fixed the worktree server canvas extension so it opens reliably again.

The `refreshState` and `getCachedState` helpers had been declared inside `discoverState()`, but they are used by canvas request handlers outside that scope. This caused runtime failures during open/refresh. I moved both helpers to module scope so all handlers can call them.

## Files Changed

- `.github/extensions/worktree-server-status/extension.mjs`

## Validation

- `npm run verify:fast`
- Reloaded extensions
- Confirmed `open_canvas` succeeds for `worktree-server-status` with a valid slug instance id (for example `worktree-status-3`)

## Note on the user-reported error

The screenshot error (`Invalid canvas instance ID`) is reproducible when the instance id contains invalid characters (for example spaces or `:`). Use a slug/UUID style instance id when opening this canvas.

## Apples

- Estimated: 🍎🍎 (2)
- Actual: 🍎🍎 (2)
- Delta: 0
- Verdict: 🎯 Exact
- Hello kitties: 0.40
