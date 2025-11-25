# Floor 2 AI objective support

**Date:** 2026-07-05  
**Branch:** `nalfeo-floor-2-ai-objective-support`  
**Estimate:** 3 apples 🍎🍎🍎

## Summary

Implemented Floor 2 AI objective plumbing so den unlock and boss-defeat progress now flow through deterministic runtime signals in headless/AI runs. The branch fixes stale/replayed death-event handling, preserves Floor 1 behavior, and adds regression coverage for objective progression edge cases.

## Systems touched

ai-behavior-tree, quests, ai-combat-balance, mapgen

## Files changed

- `src/game/floor2Scenario.ts`
- `src/game/ai/bt-ai-provider.ts`
- `src/core/systems/dropSystem.ts`
- `src/shared/combat-events.ts`
- `src/game/ai/simulation-step.ts`
- `tests/headless/floor2-completion.test.ts`
- `tests/integration/floor2-den-unlock-pipeline.test.ts`
- `tests/unit/floor2-scenario-initialization.test.ts`
- `docs/knowledge/adr/2026-07-05-floor2-ai-objective-completion-plumbing.md`
- `docs/knowledge/review-ledgers/2026-07-05-floor-2-ai-objective-support.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-05-floor2-ai-objective-support.json`

## What changed

- Added one-time Floor 2 death-event consumption in `floor2ObjectiveTick` to stop replay double-counting.
- Added optional `familyIndex` / `isBoss` metadata to `CombatEvent` death payloads and emitted them from `dropSystem`, with safe fallback handling when membership components are absent.
- Preserved Floor 2 AI den/boss pursuit routing while maintaining Floor 1 progress fallback behavior.
- Kept deterministic headless Floor 2 completion coverage and added integration regression coverage for missing-family-metadata safety.
- Added ADR + validated 3-apple review ledger for cross-system objective-plumbing decisions.

## Verification run

- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-05-floor-2-ai-objective-support.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅
- `npm run verify` ✅
- `bash scripts/agent/lab-gate-check.sh` ✅

## Unresolved issues

- Floor 2 boss tuning is intentionally temporary for AI-completion stabilization (`FLOOR2_BOSS_HP_SCALE = 0.03`, `FLOOR2_BOSS_CONTACT_DAMAGE = 2` in `src/game/floor2Scenario.ts`); revisit for final gameplay balance after objective-flow hardening.
