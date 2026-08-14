# Handoff — Spell Broker PR recovery

## Systems touched

quests, ai-behavior-tree, inventory

## Summary

- Repaired Spell Broker / merchant weapon interaction so the merchant fallback remains pending while an enabled broker plan is active, then resumes once the broker plan is abandoned or disabled.
- Removed test-only public exports by internalizing the spell efficacy helper and deriving spell skill IDs from the production spell-skill map in tests/labs.
- Strengthened Spell Broker regression coverage for deterministic buy seeds, real Floor 1 budget-derived pricing, merchant fallback after broker abandonment, and representative non-fireball efficacy paths.
- Updated the AI runner wiring regression to include both merchant and spell-broker lab toggles.

## Apples

- Estimated: 2🍎
- Actual: 2🍎

## Validation

- `npx vitest run tests/game/spell-broker-progression.test.ts tests/game/merchant-weapon-purchase.test.ts tests/unit/ai-runner-merchant-weapon-wiring.test.ts` ✅
- `npm run check:test-only-exports` ✅
- `npm run typecheck` ✅
- `npm run verify:fast` ✅

## Notes

- Preflight attempted its automatic main sync, but the rebase aborted cleanly due to the environment's commit-signing/GPG failure before changing branch state.
