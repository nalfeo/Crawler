# Handoff: Sprite Unapprove / Eviction Feature

**Date:** 2026-07-23
**Session slug:** sprite-unapprove-eviction
**PR branch:** `copilot/nalfeo-approve-sprites-variants`
**Closes:** #1794

## Systems touched

sprite-pipeline, devtools

## Summary

Added a wholesale sprite eviction feature — the inverse of `approveVariant()`. Previously,
sprites could only receive a thumbs-down (metadata only); there was no way to remove an
approved sprite that had been hooked into the game. This session adds full eviction across
all three locations that `approveVariant()` writes to.

## What was done

### Core logic (`scripts/sprites/approve.ts`)

- Added `unlinkSync` to imports
- Added `UnapproveFs` interface (extends `ApproveFs` with `unlinkSync`)
- Added `DEFAULT_UNAPPROVE_FS` constant
- Added `UnapproveError` class with kinds: `not-found` | `manifest-invalid`
- Added `UnapproveVariantOptions` interface
- Added `unapproveVariant()` function:
  - Removes the entry from `public/assets/generated/manifest.json`
  - Removes the entry from `src/shared/data/sprite-catalog.json`
  - Deletes `public/assets/generated/<variantId>.png` (unless `deleteAsset: false`)
  - Path-traversal guard: resolved asset path must stay inside `generated/`

### CLI (`scripts/sprites/unapprove-cli.ts`) — NEW FILE

- `npm run sprites:unapprove -- <variantId> [--keep-asset]`
- Exit codes: 0=success, 1=unknown, 2=not-found, 3=manifest-invalid

### Sidecar HTTP route (`scripts/sprites/sidecar/server.ts`)

- Added `DELETE /api/manifest/:variantId`
- CI guard (403 when `env.CI !== undefined`)
- Input validation (rejects variantIds containing `/` or `\`)
- Runs under `withCheckinMutationLock` (serialized with `/approve` and `/checkin`)
- Returns evicted manifest entry or 404/500

### Client API (`src/devtools/sprite-approval-api.ts`)

- Added `UnapproveResponse` type
- Added `UnapproveRequestError` error class
- Added `deleteApprovedVariant(variantId)` function

### Tests

- `tests/unit/sprites/approve.test.ts`: 9 new test cases for `unapproveVariant`
- `tests/unit/sprites/sidecar-server.test.ts`: 5 new test cases for `DELETE /api/manifest/:variantId`

### Package / docs

- Added `sprites:unapprove` to `package.json` scripts
- Added `Sprite unapprove` row to `AGENTS.md` command table

## Key decisions

1. **Extended `ApproveFs` → `UnapproveFs`** rather than modifying the existing interface, so all existing tests that inject fake `ApproveFs` objects continue to compile without changes.
2. **Path-traversal guard** on both the function level (resolved path check) and sidecar route level (regex rejecting `/` and `\` in variantId).
3. **Mutation lock** on the sidecar route — same `withCheckinMutationLock` used by `/approve` and `/checkin` to prevent concurrent manifest corruption.
4. **`deleteAsset: false` option** — lets callers keep the PNG on disk for inspection before re-generating. CLI exposes as `--keep-asset`.

## Apple estimate

🍎🍎 (2 apples) — pure tooling, no gameplay changes. Review harness: no stages required (1-2🍎 tier).
