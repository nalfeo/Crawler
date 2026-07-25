# Squick UNDERCITY MOB CALL PR recovery

**Date**: 2026-07-25  
**Session slug**: squick-undercity-pr-recovery  
**Apple estimate**: 🍎🍎 (2 apples)  
**PR**: #1962

## Systems touched

enemies, vfx, ci-policy

## Summary

Recovered PR #1962 against listed CI and review blockers by applying targeted
fixes:

- corrected Floor 2 status ownership so Nana no longer carries Squick evidence;
- preserved `abilityId` through mob-ability pending burst queue and dispatched
  Squick-specific undercity resolution bursts in renderer;
- fixed partial-cap unit scenario to truly exercise `<3 remaining slots`;
- extended Squick arena e2e observation with deterministic cleanup checks after
  caster removal.

## Files touched

- `scripts/agent/data/boss-abilities.floor2.status.json`
- `src/core/mob-abilities/types.ts`
- `src/core/mob-abilities/runtime.ts`
- `src/engine/MobAbilityVfx.ts`
- `tests/unit/mob-ability-vfx.test.ts`
- `tests/unit/mob-abilities/undercity-mob-call.test.ts`
- `tests/e2e/squick-arena-observation.test.ts`
- `docs/knowledge/adr/0074-squick-undercity-burst-dispatch-and-status-ownership.md`
- `docs/knowledge/review-ledgers/2026-07-25-squick-undercity-mob-call-pr-recovery.review-ledger.json`

## Verification

- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-25-squick-undercity-mob-call-pr-recovery.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ❌ (before adding ADR/handoff/ledger; blockers addressed in this recovery commit)
- `npm run verify:fast` ❌ local environment dependency/network issue (`npm ci` cannot reach package feed; local `vitest` unavailable)

## Remaining risk / next step

- Re-run CI to verify lint/unit/e2e gates in GitHub-hosted environment now that
  review and metadata corrections are committed.
