# Handoff: Aggregate Row Ownership Guard

**Date**: 2026-07-29  
**Session slug**: aggregate-row-ownership-guard  
**Issue**: #2282  
**PR**: (to be assigned)  
**Apple estimate**: 3🍎 (tooling-only cap)

## Systems touched

health-checks, ci

## Problem solved

A recurring silent data-loss pattern: when a PR regenerates an aggregate file (e.g. `manifest.json`, `boss-abilities.floor2.status.json`) from a stale snapshot taken before a concurrent PR merged, it carries old row values that overwrite what main gained. Merge conflicts are the only existing detection — when git doesn't conflict, the revert lands silently.

Three confirmed instances:
- **manifest.json** (PR #1972): `opaqueBounds` stripped from 462/464 entries
- **boss-abilities.floor2.status.json** (PRs #2010, #2022): `don-paco` rolled back from `verified/verified/verified` to `not-started/planned/blocked`
- **sprite-catalog.json**: removed from write path in #2248 (excluded from registry)

## What was built

A new CI guard that compares three git versions of each registered aggregate file (PR head, merge-base, origin/main) and fails when the PR carries a stale regeneration:

### Files created

| File | Description |
|------|-------------|
| `scripts/agent/health/check-aggregate-row-ownership-lib.ts` | Pure logic: canonicalize, extractManifestRows, extractBossAbilityRows, checkRowOwnership, REGISTRY |
| `scripts/agent/health/check-aggregate-row-ownership.ts` | CLI entry point (git operations, CI env detection) |
| `tests/unit/agent/check-aggregate-row-ownership.test.ts` | Unit tests for all rules and edge cases |
| `docs/knowledge/review-ledgers/2026-07-29-aggregate-row-ownership-guard.review-ledger.json` | Review ledger |

### Files modified

| File | Change |
|------|--------|
| `package.json` | Added `check:aggregate-row-ownership` script |
| `.github/workflows/ci.yml` | Added `check-aggregate-rows` job and wired to merge-gate |

## Algorithm

Three violation kinds are detected:

1. **Stale row** — `prHead[K] == mergeBase[K]` AND `mergeBase[K] != main[K]`. The PR is carrying the exact stale merge-base value while main has already advanced. This directly reproduces the don-paco case (PRs #2010/#2022 carried identical stale state).

2. **Deleted row** — Row exists in both merge-base and main but is absent in the PR's version of the file.

3. **Deleted field** — A top-level field exists in both `mergeBase[K]` and `main[K]` but is missing from `PR[K]`. This catches the `opaqueBounds` stripping case from PR #1972. Rule 3 is skipped if Rule 2 already fired (avoids double-reporting).

**Why Algorithm B (stale-only) not Algorithm A**: Algorithm A would fire false positives when a PR legitimately updates a row to a value not yet on main. Algorithm B only fires when the PR is a verbatim copy of the stale merge-base value.

### Row key naming

- manifest.json: row key = sprite entry key (e.g. `goblin-basic-idle-var-0`)
- boss-abilities: entries keyed as `entry:<abilityId>`, gates as `gate:<id>`

### Registered files

- `public/assets/generated/manifest.json`
- `scripts/agent/data/boss-abilities.floor2.status.json`

`sprite-catalog.json` is explicitly excluded (removed from commit write path in #2248).

## CI architecture

- New dedicated job `check-aggregate-rows` (PR-only, not modifying `check-lightweight`)
- `fetch-depth: 0` required for `git merge-base` computation
- Skipped for `docs_only` changes; hard-fails in CI when merge-base is unavailable
- `PR_HEAD_SHA` env var passed from `${{ github.event.pull_request.head.sha }}`
- SHA format validated before use (`/^[0-9a-f]{7,40}$/`) to prevent shell injection
- Canary check: errors if 0 rows were checked across all registered files
- Wired to merge-gate with `allow_skipped=true` (push-to-main naturally skips)

## Key design decisions

- **Algorithm B not A** — avoids false positives for legitimate row updates
- **Separate dedicated job** — keeps `check-lightweight` shallow, avoids slowing other checks
- **Hard-fail on missing merge-base in CI** — B4 finding from plan review; silent skips hide config problems
- **Recursive key sorting in canonicalize()** — avoids false positives from JSON formatting differences
- **No escape hatch in MVP** — error messages are clear; teams can rebase to fix

## Plan review findings (claude-opus-5)

All 7 findings resolved:
- B1: fetch-depth fix (dedicated job pattern)
- B2: volatile fields non-issue for these specific files
- B3: deleted-row and deleted-field rules added
- B4: hard-fail in CI branch
- N1: recursive canonicalize
- N2: duplicate ID detection
- S1: SHA validation + array args

## Known limitations

- No escape hatch: a PR that intentionally reverts a row must explicitly update origin/main first. This is intentional for the MVP — the error message explains the fix.
- The guard only runs on `pull_request` events; post-merge pushes are not checked (by design — pre-merge detection is the goal).
- Whole-row comparison for deleted-field uses JSON.parse on the canonicalized string; this is fine but means `mergeBase[K]` must round-trip through canonicalize.
