# Weapon-specific AI stat personas

**Date:** 2026-07-11  
**Persona:** Game Designer  
**Apples:** Estimated 🍎🍎🍎 · Actual 🍎🍎🍎 · 🎯 exact

## Systems touched

ai-combat-balance, inventory

## Summary

- Added six deterministic AI-runner profiles for the Floor 1 starter weapons. Each
  has a unique debug name, primary/secondary stat weights, and constitution-first
  minimum targets.
- Added a default-off `weaponPersonas` flag to the headless runner, CLI
  (`--weapon-personas`), and AI Runner lab. Disabled mode keeps the legacy stat
  allocator and equipment flow.
- Enabled mode allocates level-up points against minimum targets before weighted
  preferences and ranks equippable bag items by target deficits plus profile
  weights.
- The active persona name appears only in the AI Runner lab debug panel.

## Files touched

- `src/game/ai/weapon-personas.ts`
- `src/game/ai/auto-progression.ts`
- `src/game/ai/headless-runner.ts`
- `src/game/ai/headless-runner-cli.ts`
- `src/game/ai/headless-runner-cli-lib.ts`
- `src/game/ai/index.ts`
- `src/labs/ai-runner-lab/index.ts`
- `tests/unit/weapon-personas.test.ts`
- `tests/unit/ai/headless-runner-cli-lib.test.ts`
- `tests/unit/ai-level-up-ux-wiring.test.ts`

## Runtime observation

- Real headless pipeline, seed 42, bow, level 10: flag off produced the legacy
  `{strength:11, constitution:16}` allocation; flag on produced
  `{dexterity:12, constitution:10, luck:5}`.
- Real browser AI Runner lab: debug panel showed `Persona: Off` by default and
  `Persona: Vanguard` after enabling the experimental toggle and resolving the
  starter loadout.

## Verification run

- `npm run verify:fast` ✅
- Separate-model plan review ✅ (`gpt-5.4`, minor divergence)
- Two-round code-review loop ✅ (`claude-sonnet-4.6`; one gear-order concern fixed,
  second round clean)

## Unresolved issues

- The six profiles are intentionally unbalanced starting values. The feature flag
  remains off by default until broad weapon sweeps and human balance review approve
  enabling it.

## Recommended next steps

1. Run the GitHub-backed 100-seed × six-weapon sweep with personas enabled.
2. Compare win rate, final stat distributions, and gear choices by persona.
3. Tune profiles, then make a separate human-approved decision about the default.
