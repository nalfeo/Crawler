# Handoff: CI Recovery Slash-SHA Marker Parser Fix

**Date:** 2026-07-18  
**Session:** ci-recovery-slash-sha-marker-fix  
**PR:** #1613 (closes issue #1609, incident on PR #1396)

## Systems touched

ci-policy

## Persona

DevOps Engineer

## Apples

Estimated 🍎, actual 🍎. Exact: the parser and post-main compatibility fix stayed within existing CI recovery logic and tests.

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

Updated `parseMarkerShaToken` to validate exactly two slash-separated hex-SHA components and return the second (later) SHA. Requiring both components to be valid SHAs prevents false positives from malformed tokens like `abc1234/not-a-sha` or `abc1234/def5678/extra`. Returning the second SHA ensures its ancestry in the lineage check proves the complete pair is present.

After updating the branch from `main`, aligned the stale-marker regression fixture
with canonical PR #1619 semantics by setting `isOutdated: false`. Outdated threads
are intentionally resolved by the reconciler, while this fixture specifically
tests an unresolved current-code thread whose marker names a never-pushed SHA.

```js
// Handle slash-separated SHA pairs like "9adef25/28f3d0f" (agents sometimes
// write two SHAs when a fix spans multiple commits). Require exactly two
// hex-SHA components; return the second (later) SHA so its ancestry proves
// the complete pair is present.
const slashParts = token.split('/');
if (slashParts.length === 2) {
  const [firstPart, secondPart] = slashParts;
  if (hexShaPattern.test(firstPart) && hexShaPattern.test(secondPart)) {
    return secondPart.toLowerCase();
  }
}
```

## Files Changed

- `.github/scripts/ci-recovery/state.mjs` — fix in `parseMarkerShaToken`
- `.github/scripts/ci-recovery/state.test.mjs` — regression tests (second-SHA extraction, malformed-second-component cases)
- `.github/scripts/ci-recovery/reconcile.test.mjs` — preserve the stale-lineage test under canonical outdated-thread semantics
- `docs/knowledge/review-ledgers/2026-07-18-ci-recovery-slash-sha-marker-fix.review-ledger.json` — 1🍎 ledger

## Verification

- All 33 CI recovery state tests pass
- CI recovery reconciliation tests pass with the PR #1619-compatible stale-marker fixture
- `npm run verify:fast` passes cleanly
