# Handoff: Sovereign Cap Spore Bloom runtime slice

## Date

2026-07-25

## Persona

Producer

## Systems touched

enemies, vfx, ai-behavior-tree, boss-rooms

## Apples

5🍎 estimated, 5🍎 actual.

## What Was Done

- Added `src/core/mob-abilities/sovereign-spore-bloom.ts`, a typed adapter/handler for `sovereign-cap-spore-bloom` (no generic `designValues` interpreter).
- Extended mob-ability runtime/types with:
  - optional definition-level committed-geometry callback,
  - multi-circle geometry support,
  - runtime-owned persistent zone lifecycle (`ownedZones`) with deterministic fixed-step ticks,
  - cleanup integration for death/despawn/encounter disable/recycled IDs.
- Wired Sovereign Cap into canonical combat arena via new preset `f2-sovereign-cap` in `src/labs/combat-arena-lab/arena-data.ts`.
- Extended renderer and AI to consume the same committed geometry:
  - telegraph/burst handling for multi-circle geometry,
  - persistent toxic-cloud rendering in `MobAbilityVfx`,
  - danger avoidance for both telegraphs and active owned zones in `bt-ai-provider`.
- Updated status tracking entry in `scripts/agent/data/boss-abilities.floor2.status.json` for issue #1951, including arena/runtime evidence state while keeping `floor2-boss-production-enable` blocker.
- Added deterministic coverage and evidence artifacts:
  - `tests/unit/mob-abilities/sovereign-spore-bloom.test.ts`
  - `tests/e2e/sovereign-cap-arena-observation.test.ts`
  - `scripts/agent/sovereign-cap-arena-evidence.ts`
  - plus targeted updates in existing AI/VFX/arena/status tests.

## Validation

- Attempted `npm run verify:fast` (before and after changes) — **blocked** in this sandbox because dependencies are unavailable.
  - `npm ci` failed with network resolution error to package feed host.
  - `verify:fast` then failed because `tsc`/ESLint dependencies were missing.
- Attempted `npm run boss-abilities:status` — **blocked** (`tsx: not found`) for same dependency reason.
- Ran `parallel_validation`:
  - Code review: no findings (tool reported model-availability warning in environment).
  - CodeQL: 0 alerts; analysis noted database-size skip.

## Blockers / Notes

- Could not post the requested pre-code issue plan comment via `gh issue comment` due `HTTP 403` from this sandbox’s GitHub API access.
- Production enablement remains intentionally blocked by `floor2-boss-production-enable`.
