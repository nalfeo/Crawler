# Optional AI merchant weapon purchase

**Date:** 2026-07-11  
**Persona:** Producer → Systems/AI, QA  
**Apples:** 🍎🍎🍎🍎 estimated → 🍎🍎🍎🍎 actual (exact)

## Systems touched

ai-behavior-tree, ai-combat-balance, inventory, quests

## Summary

- Added a default-off, per-world merchant weapon intent.
- After the merchant quest completes, enabled runs make one seeded 50% decision and uniformly
  select one stocked weapon on the buy branch.
- The AI farms the selected price deficit only while the canonical Floor 1 plan has sufficient
  slack, then returns, purchases, and force-swaps the weapon into its hand slots.
- Wired `AI_MERCHANT_WEAPON_PURCHASE` and `--merchant-weapon-purchase` through the headless CLI,
  plus a persisted AI-runner lab toggle.
- Added deterministic coverage for flag-off RNG parity, one-shot decisions, branch/selection
  distributions, slack farming/abandonment, toggle behavior, and purchase/equip.

## Runtime observation

An enabled real headless seed-1 run won Floor 1 in 15,271 frames. The final intent was
`purchased` with `crystal-wand` at 28 gold.

## Verification

- `npm run verify:fast` passed.
- Focused merchant/planner/CLI/lab tests passed (26 tests before review fix; review-fix regression
  also passed).
- Adversarial plan review considered three alternatives.
- Review round 1 found one valid toggle-off navigation bug; it was fixed and regression-tested.

## Decisions

The optional purchase is compared against existing planner slack rather than inserted into the
critical plan, avoiding double-counting the planner safety buffer. Intent state remains latched
when the lab toggle is disabled so re-enabling cannot make a second RNG decision.
