# Fix: remove inert weapon entity path and harden allowlist tracking

**Date:** 2026-07-31  
**Session slug:** weapon-entity-inert  
**Apple estimate:** 3🍎  
**PR closes:** #2442

## Systems touched

weapons, ci-policy

## Problem

`weaponEntitySystem` and its sole producer `spawnWeapon` were still shipped inert:
all production callers were absent, but the orphaned-systems allowlist entry made
that look intentionally tracked. Issue #666 had also been closed on 2026-07-11, so
nothing active still tracked the debt.

The current-code audit matched the issue report:

- `src/game/weaponSystem.ts` exported `weaponEntitySystem`, but every runtime path
  still used the singleton `weaponSystem`.
- `src/core/spawners/pickups.ts` exported `spawnWeapon`, but only tests called it.
- No real pipeline wiring site referenced either symbol.

## #666 disposition

The close was **not** a completed wire/remove fix.

- Commit search showed `weaponEntitySystem` was introduced in the original weapons
  feature commit and later only mentioned when the orphaned-system guard PR filed
  it as tracked debt.
- Issue #666's closing comment says the linked cleanup draft was abandoned after
  the codebase evolved, not that the runtime was wired or the feature removed.
- So the dormant condition persisted while the issue was closed; the new issue was
  the correct follow-up record.

## Fix

### 1. Delete the dormant multi-weapon entity path

Removed the never-wired feature instead of wiring it:

- deleted `weaponEntitySystem` from `src/game/weaponSystem.ts`
- removed its barrel export from `src/game/index.ts`
- deleted `spawnWeapon` from `src/core/spawners/pickups.ts`
- removed the dead-path tests that only exercised the inert code
- updated live docs (`docs/systems/03-weapons.md`, `docs/architecture.md`) so they
  no longer describe the removed path as part of the shipped system

This was the smallest correct fix because shipped gameplay already runs through the
singleton `weaponSystem`; wiring the dormant path would have required new runtime
producers plus visual/headless pipeline work.

### 2. Harden allowlist tracking

Extended the orphaned-systems allowlist contract:

- each entry now declares `trackedIssuePolicy`:
  - `reference-only` for provenance / explanatory refs that may legitimately be closed
  - `open-required` for live debt that must stay open while the allowlist entry remains
- the guard now validates this metadata and can resolve repo-local `#123` issue refs
- when `GITHUB_TOKEN` is available, `check:wired-systems` queries GitHub issue state
  and reports an `open-required` entry whose tracking issue is already closed
- CI now passes `github.token` into the orphaned-system guard step so this check is
  enforced in the authoritative workflow, not just locally

The two surviving allowlist entries were classified as `reference-only`:

- `enemySpawnerSystem` — legitimate lab/test helper
- `floor2EnemyDirectorSystem` — legitimate function-pointer indirection

## Files changed

| File                                                                                | Change                                                                                  |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                                          | Passed `GITHUB_TOKEN` to the orphaned-system wiring guard step                          |
| `docs/knowledge/adr/0081-weapon-entity-retirement-and-allowlist-tracking-policy.md` | Recorded the cross-layer wire-vs-delete + allowlist-tracking policy decision            |
| `src/game/weaponSystem.ts`                                                          | Removed `weaponEntitySystem`                                                            |
| `src/game/index.ts`                                                                 | Removed `weaponEntitySystem` export                                                     |
| `src/core/spawners/pickups.ts`                                                      | Removed `spawnWeapon`                                                                   |
| `scripts/agent/health/orphaned-systems-lib.ts`                                      | Added `trackedIssuePolicy` + issue-state helper logic; removed obsolete allowlist entry |
| `scripts/agent/health/orphaned-systems.ts`                                          | Added tracked-issue state auditing/reporting                                            |
| `tests/unit/orphaned-systems-guard.test.ts`                                         | Added coverage for policy validation and closed tracked issues                          |
| `tests/game/weapon-system-coverage.test.ts`                                         | Removed inert-path-only tests                                                           |
| `tests/ecs/spawners/pickups.test.ts`                                                | Removed deleted `spawnWeapon` test                                                      |
| `tests/ecs/helpers.test.ts`                                                         | Removed deleted facade export expectation                                               |
| `docs/systems/03-weapons.md`                                                        | Removed the deleted weapon-entity path from live docs                                   |
| `docs/architecture.md`                                                              | Removed the deleted weapon-entity path from the live architecture inventory             |
| `docs/knowledge/review-ledgers/2026-07-31-weapon-entity-inert.review-ledger.json`   | 3🍎 review ledger                                                                       |

## Validation

- `npx vitest run tests/unit/orphaned-systems-guard.test.ts tests/ecs/spawners/pickups.test.ts tests/ecs/helpers.test.ts tests/game/weapon-system-coverage.test.ts --reporter=dot`
- `npm run check:wired-systems`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-31-weapon-entity-inert.review-ledger.json`

## Notes

- I attempted to post the required pre-code plan comment on issue #2442, but the
  available GitHub credentials in this session returned HTTP 403 for both `gh issue comment`
  and direct REST calls. The same plan summary was still recorded locally and should be
  mirrored in the PR description.
- No guard-telemetry capture was needed because `files/guard-telemetry.jsonl` was absent.
- Apples actual: 3🍎 — 🎯 exact. The task stayed medium-sized: one dormant gameplay path,
  one guard hardening, targeted tests, and CI workflow plumbing.
