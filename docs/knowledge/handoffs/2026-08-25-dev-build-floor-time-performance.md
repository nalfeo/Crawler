# Handoff: Dev build floor-time performance recovery

## Date

2026-08-25

## Systems touched

hud-rendering

## Persona

Perf Optimizer

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact).

## Summary

Recovered PR #3619 after review correctly found that the branch only contained
incomplete review-ledger scaffolding. The implementation now removes redundant
minimap render work in the dev/game surface: floors without family state skip
family-palette room marker lookup, and floors without territory zones skip the
per-radar-tile territory tint pass.

The change is render-only. It does not alter tick rate, tuning, entity counts,
RNG consumption, system order, or simulation state.

## Measurement and observation

- Real artifact observed: `npm run dev` serving the browser `main-scene-probe-lab`
  surface via a temporary Playwright measurement script under `/tmp/crawler-perf-3618/`.
- Azure artifact limitation: the issue-linked Azure dev-build artifact was not
  accessible from this session, so the local browser probe is the best available
  same-machine reproduction. It reproduced a milder slowdown than the reported
  2–3× Azure symptom.
- Before samples, same machine/back-to-back: median wall-clock/floor-time ratio
  `1.1707542480701707`, spread `1.144094068571425`–`1.405433056580787`.
- Browser CPU attribution: named hot work was in HUD/rendering (`HudUI.sync`,
  `PhaserBridge.sync`, `updateDoorOverlay`, and WebGL work), not headless-only
  simulation.
- After samples, same machine/back-to-back: median wall-clock/floor-time ratio
  `1.1240146671910085`, spread `1.110141846876153`–`1.150238764137927`.
- Result: median improved from `1.171×` to `1.124×`; worst-sample stall improved
  from `1.405×` to `1.150×`.

## Verification

- `npm run test:unit -- --run tests/unit/hud-minimap-territory-guard.test.ts`
  — passed.
- `npm run format:check -- src/engine/HudMinimap.ts src/engine/minimap-territory-guards.ts tests/unit/hud-minimap-territory-guard.test.ts`
  — passed.
- `npm run test:mutate -- src/engine/minimap-territory-guards.ts:4-11 --tests tests/unit/hud-minimap-territory-guard.test.ts`
  — passed before the role-aware guard refinement; 9/9 scoped mutants killed.
- `npm run test:mutate -- src/engine/minimap-territory-guards.ts:4-19 --tests tests/unit/hud-minimap-territory-guard.test.ts`
  — passed after the role-aware guard refinement; 21/21 scoped mutants killed,
  100% mutation score.
- `npm run perf:fingerprint -- --seeds 1-3 --weapons sword --write /tmp/crawler-perf-3618/fingerprint-before.json`
  followed by the same-sample check after the render change — passed with hash
  `0c9fb547011ef0e9494d202ce9da9a6005d360f2718c0ea6f78fab0299048a3f`.
- `npm run verify:fast` — passed after the final null-sentinel guard fix.

## Review and policy notes

- Separate-model recovery validation found the PR review blocker valid.
- Automated code review found one guard edge case (`familyState: null` should be
  absent); fixed with `!= null` and added a regression assertion.
- Independent grade then caught a Floor 3 regression risk: territory-style room
  roles can need fallback marker colors without Floor 2 family state. The guard
  is now role-aware, and tests/mutation cover all fallback-tinted roles.
- Follow-up automated code review requested documenting why fallback-tinted roles
  still call `familyTintForRoom` without family state; addressed with an inline
  comment.
- Full 24-run fingerprint is intentionally left to GitHub infrastructure per
  the >10-run policy; local proof used the allowed narrowed sample as collateral
  sim-drift evidence for a render-only change.

## Unresolved issues

None known.
