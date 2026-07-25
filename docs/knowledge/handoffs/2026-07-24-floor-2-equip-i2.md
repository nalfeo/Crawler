# Handoff: Floor 2 equipment integration validation (I2)

## Date

2026-07-24

## Persona

QA Engineer

## Systems touched

inventory, weapons, quests, boss-rooms, ai-behavior-tree, hud-ux, ci-policy

## Apples

3 apples estimated, 3 apples actual. This stayed in the intended QA/integration
slice: one new real-pipeline integration test, no runtime production changes,
and a full deterministic seam gate across the existing reward/equipment/AI
coverage set.

## Summary

Completed the Floor 2 equipment epic integration-validation slice by auditing the
existing deterministic reward/equipment/AI seams, mapping the end-to-end coverage,
and adding only the missing real-pipeline proof:

- Extended `tests/integration/generated-equipment-pipeline.integration.test.ts`
  with a Floor 2 runtime-state integration that:
  - boots the real `initializeFloor2Scenario` path and asserts the shipped Floor 2
    equipment unlock/flag closure is actually enabled;
  - proves a generated two-handed item displaces both occupied hand slots through
    the real equip pipeline;
  - proves generated active grants remain **owned but unequipped** at the true
    `ACTIVE_ABILITY_SLOT_LIMIT` cap instead of evicting existing equipped actives;
  - proves generated passive grants attach while equipped and are revoked cleanly
    when a replacement two-hander displaces the source item.
- Left production/runtime code unchanged. No genuine equipment seam bug surfaced;
  the gap was coverage, not runtime behavior.

## Seam coverage matrix

- Achievement unlock, immutable reward resolution, exact-once claim, no reroll on
  open/load, Floor 1 no-equipment invariant, Floor 2 reward policy seams,
  fail-closed stale/missing bundle refs:
  `tests/integration/floor2-reward-bundle-claim.integration.test.ts`
- Boss defeat -> chest record -> open/ack/claim, carryover of unopened/opened chest
  state, fail-closed stale/missing chest refs:
  `tests/integration/boss-chest-lifecycle.integration.test.ts`,
  `tests/headless/boss-chest-lifecycle.test.ts`
- Achievement reward presentation/open/claim UX, skip/reduced motion/input
  ownership/cleanup:
  `tests/e2e/reward-opening-ux.test.ts`
- Boss chest runtime surfaces and presentation paths:
  `tests/e2e/main-game-scene-ui-exclusivity.test.ts`,
  `tests/e2e/reward-opening-ux.test.ts`
- Reward-opening audio lifecycle:
  `tests/integration/reward-opening-audio-pipeline.test.ts`
- Generated-equipment registry/inventory/equip/loadout, multi-slot displacement,
  source-owned active/passive grants, active-slot cap behavior:
  `tests/integration/generated-equipment-pipeline.integration.test.ts`,
  `tests/integration/equipment-loadout-evaluator.integration.test.ts`
- Floor carryover of generated registry/inventory/loadout/reward state:
  `tests/integration/floor-transition-carryover.test.ts`
- Quartermaster generated stock and atomic legitimate purchase:
  `tests/integration/floor2-settlement-broker.test.ts`,
  `tests/e2e/main-game-scene-quartermaster.test.ts`,
  `tests/headless/floor2-completion.test.ts`
- Deterministic AI settlement maintenance + safe-room return routing through real
  pathing/APIs:
  `tests/headless/settlement-return-routing.test.ts`,
  `tests/headless/floor2-completion.test.ts`

## Validation

- `npm run test:integration -- tests/integration/floor2-reward-bundle-claim.integration.test.ts tests/integration/boss-chest-lifecycle.integration.test.ts tests/integration/reward-opening-audio-pipeline.test.ts tests/integration/floor2-settlement-broker.test.ts tests/integration/floor-transition-carryover.test.ts tests/integration/generated-equipment-pipeline.integration.test.ts tests/integration/equipment-loadout-evaluator.integration.test.ts` — 76/76 passing.
- `npm run test:headless -- tests/headless/boss-chest-lifecycle.test.ts tests/headless/settlement-return-routing.test.ts tests/headless/floor2-completion.test.ts` — 15/15 passing.
- `npm run test:e2e -- tests/e2e/reward-opening-ux.test.ts tests/e2e/main-game-scene-quartermaster.test.ts tests/e2e/main-game-scene-ui-exclusivity.test.ts` — 23/23 passing.
- `C:\Program Files\Git\bin\bash.exe scripts/agent/ci/local-scope.sh` — `gameplay_safe=false`.
- `C:\Program Files\Git\bin\bash.exe scripts/agent/verify-fast.sh` — passed.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-24-floor-2-equip-i2.review-ledger.json` — valid 3-apple ledger.

## Review

- Plan review (`gpt-5.4`): `approved_with_changes`, `plan_divergence: minor`.
  Tightened the explicit hard gate, refined the seam matrix to per-pipeline rows,
  and separated gate-green validation from PR logistics.
- Code review (`gpt-5.4`, 2 rounds): round 1 found 2 valid issues in the new
  integration test (Floor 1 setup on a Floor 2 world, and a false-green slot-cap
  assertion); both were fixed. Round 2 was clean after recording the actual review
  rounds in the ledger.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-24-floor-2-equip-i2.review-ledger.json`

## Unresolved issues

None in-scope. The only environment issue encountered was a local npm registry/TLS
problem in this worktree; verification proceeded through a local `node_modules`
junction to another Crawler worktree with the same dependency tree, with no repo
files changed for that workaround.

## Recommended next steps

Re-run `npm run verify:pr-prereqs` now that this handoff exists, then publish one
ready PR summarizing the seam matrix, the single added integration test, the zero
runtime-change result, and the deterministic suite evidence.
