# Handoff: CI Recovery Slash-SHA Marker Parser Fix

**Date:** 2026-07-18  
**Session:** ci-recovery-slash-sha-marker-fix  
**PR:** #1609 (closes #1609, incident on #1396)

## Systems touched

ci-recovery

## Problem

CI recovery loop for PR #1396 (`feat(art): add venom-dirk weapon brief`) failed to converge after 2 attempts. The blocker was review thread `PRRT_kwDOSvo2Ms6R8-DW` remaining unresolved.

The last comment in that thread (from `copilot-swe-agent`) was:

```
✅ Addressed in 9adef25/28f3d0f: Handoff and PR description are fully reconciled...
```

## Root Cause

`parseMarkerShaToken` in `.github/scripts/ci-recovery/state.mjs` only accepted:
1. A single plain hex SHA (`[0-9a-f]{7,40}`)
2. A full GitHub commit URL

When agents address a finding that spans two commits, they sometimes write
`"✅ Addressed in sha1/sha2:"` with a slash-separated pair. The token after
stripping trailing punctuation was `9adef25/28f3d0f` — not a valid hex SHA
(contains `/`) and not a URL — so `parseMarkerShaToken` returned `null`.

As a result:
- `extractAddressedMarkerSha` returned `null`
- `9adef25` was never added to `markerShasNeedingLineageCheck`
- `markerNamesHead` returned `false` for the marker
- `shouldResolveThread` returned `false`
- Thread was never auto-resolved
- CI recovery loop could not converge

## Fix

Added a slash-separated SHA pair path in `parseMarkerShaToken`:

```js
// Handle slash-separated SHA pairs like "9adef25/28f3d0f" (agents sometimes
// write two SHAs when a fix spans multiple commits). Use the first component.
const slashIdx = token.indexOf('/');
if (slashIdx !== -1) {
  const firstPart = token.slice(0, slashIdx);
  if (hexShaPattern.test(firstPart)) {
    return firstPart.toLowerCase();
  }
}
```

The first SHA is used and fed into the existing lineage-check path (ancestor compare).

## Files Changed

- `.github/scripts/ci-recovery/state.mjs` — fix in `parseMarkerShaToken`
- `.github/scripts/ci-recovery/state.test.mjs` — two new regression tests

## Verification

- All 33 CI recovery state tests pass (31 pre-existing + 2 new)
- `npm run verify:fast` passes (1 pre-existing unrelated failure in epic-status test due to shallow clone)
