# Floor 2 equipment economy flag wiring

## Systems touched

floor2, generated-equipment, ai-headless

## Summary

Wired `floor2EquipmentEconomy` (the fourth and last of the Floor 2
generated-equipment flags) into the real shipped Floor 2 init path
(`src/game/floor2Scenario.ts`), which previously enabled only 3 of the 4 flags
(`floor2EquipmentRegistry`, `floor2EquipmentCatalog`, `floor2EquipmentRewards`)
and left `floor2EquipmentEconomy` `true` only inside three labs — the exact
"shipped inert" failure class documented in ADR 0034/0036. Confirmed against
`docs/knowledge/epics/floor-2-equipment/PLAN.md`'s product contract that
Quartermaster equipment stock/purchasing and boss-chest rarity resolution
(85% Uncommon / 15% Rare) are intended to be live on Floor 2, not
lab/test-only. The flag is now `true` on the real path used by both
`MainGameScene` (via `floor-main-scene-options.ts`) and the headless AI
runner (`headless-runner.ts`), so both interactive and headless Floor 2 runs
see identical behavior.

**Mid-session, a code-review pass caught a real, critical bug in the initial
flag flip** (a production-crashing regression, not a hypothetical) which is
also fixed and regression-tested here. See "Critical bug found and fixed"
below — this is the headline risk of this PR and the reason the review
harness mattered for what looked like "just a flag flip."

## What changed

- `src/game/floor2Scenario.ts`:
  - `world.floor2EquipmentFlags.floor2EquipmentEconomy = true` (the actual
    flag flip), alongside the existing 3 flags.
  - Fix for the carryover-restore crash (see below): conditionally pass
    `skipQuartermasterStock: true` to `initializeFloor2Settlement` when
    `options?.playerCarryover` is present, then bootstrap fresh Quartermaster
    stock AFTER `restorePlayerCarryover`/`initializePlayerWeaponSkills`
    complete, merging it into the settlement snapshot.
- `src/game/floor2Settlement.ts`: added a `skipQuartermasterStock?: boolean`
  option to `InitializeFloor2SettlementOptions`, gating the
  `createInitialFloor2QuartermasterStock` call.
- `src/game/ai/headless-runner.ts`: corrected a stale JSDoc comment on the
  `floor2EquipmentFlags` config option (see "Known gap" below) — no behavior
  change here.
- `tests/integration/generated-equipment-pipeline.integration.test.ts`:
  extended the existing flag-closure assertion to include
  `floor2EquipmentEconomy`.
- `tests/headless/floor2-completion.test.ts`: added two default-path
  (no-override) tests: (1) confirms Quartermaster stock and boss-chest wiring
  are live without any explicit `floor2EquipmentFlags` override, (2) confirms
  the settlement-maintenance AI planner runs its full purchase/equip decision
  loop end-to-end against real (not lab-injected) stock across a 20,000-frame
  run without throwing (asserts `decisionKinds.length > 0`, not a specific
  purchase — seed 77 legitimately finds no positive-utility swap at level 5
  with a starting charm, so a "must purchase" assertion would be seed-fragile
  rather than testing what matters: the planner runs safely against live
  stock).
- `tests/headless/boss-chest-lifecycle.test.ts`: added a default-path
  (no-override) test confirming boss chests resolve rarity via the real
  85/15 policy on Floor 2 without any flag override.
- `tests/integration/floor-transition-carryover.test.ts`: this is the
  regression guard for the critical bug below. Updated the third test's
  assertion from exact registry equality (pre/post the real
  `onFloor1Cleared -> configureWorld` transition) to a superset assertion:
  every floor1-carried instance is present unchanged in floor2's registry,
  and floor2's registry is now strictly larger (proving Quartermaster stock
  was appended after restore, not skipped or duplicated).

## Critical bug found and fixed (via review-harness code-review loop)

Flipping `floor2EquipmentEconomy = true` alone (before the fix below) caused
`initializeFloor2Settlement` to generate real Quartermaster stock into
`world.generatedEquipmentRegistry` **before** `restorePlayerCarryover` ran
during `initializeFloor2Scenario`. `restoreGeneratedEquipmentRegistry`
requires an empty registry as a precondition and hard-fails with
`registry-not-empty` otherwise. Since `capturePlayerCarryover` always
includes a `generatedEquipmentRegistry` snapshot in practice (gated only on
`runKey !== null`, and both the interactive game and the headless runner
always set a non-null run key), **this would have crashed essentially every
real Floor 1 -> Floor 2 transition** — not an edge case.

This was not caught by any pre-existing test because no test previously
exercised `initializeFloor2Scenario` with `playerCarryover` set AND the
economy flag enabled (before this PR, the economy flag was always `false`,
so `createInitialFloor2QuartermasterStock` always no-op'd and the crash was
unreachable).

**Fix**: defer Quartermaster stock generation when carryover is present
(`skipQuartermasterStock: true`), then bootstrap it immediately after
`restorePlayerCarryover` completes, merging into the settlement snapshot via
the same pattern already used by `restockFloor2Quartermaster` in
`quartermaster-stock.ts`.

**Proof (real production artifact, not a lab)**:
`tests/integration/floor-transition-carryover.test.ts` calls
`createFloorMainSceneOptions('floor1')` -> `onStairDescend` ->
`onFloor1Cleared` -> `capturePlayerCarryover` ->
`createFloorMainSceneOptions('floor2', { playerCarryover })` ->
`configureWorld` — this is the exact call chain the real interactive game
uses (`floor-main-scene-options.ts`). Verified via `git stash` on
`floor2Scenario.ts`/`floor2Settlement.ts`:

- **Pre-fix**: all 3 tests in that file throw
  `GeneratedEquipmentRegistryError: Registry restore requires an empty
registry` with the exact call stack
  `restoreGeneratedEquipmentRegistry -> restorePlayerCarryover ->
initializeFloor2Scenario -> configureWorld` — i.e., this is the real crash,
  reproduced on the real path.
- **Post-fix**: all 3 tests pass, and the registry is confirmed to be a
  proper superset (carried-over instances present unchanged, new
  Quartermaster stock appended after restore).

Also independently confirmed no other carryover-restore side effect in
`restorePlayerCarryover` (achievements, quest state, reward bundles) reads
or writes `world.floorExtendedState.settlement`, so there is no second
similar precondition-violation risk from this change.

## Known gap (documented, not fixed — pre-existing, not introduced here)

`headless-runner.ts`'s `floor2EquipmentFlags` config option is silently
clobbered for any Floor 2 run: `initializeFloor2Scenario` unconditionally
re-enables all 4 flags regardless of any caller override. This is
**pre-existing behavior for 3 of the 4 flags** (registry/catalog/rewards
were already forced `true` unconditionally before this PR) — this PR's flag
flip just makes `floor2EquipmentEconomy` consistent with the other 3, it
does not introduce a new inconsistency. No existing test relies on
overriding these to `false` on a Floor 2 run. Reordering the `Object.assign`
to run after `configureWorld` was considered and rejected as higher-risk
(untested interaction with in-`configureWorld` reads of the flags) for a
change whose actual behavior doesn't regress anything. Fixed the stale
JSDoc instead so future readers aren't misled. If a future task needs a
real per-run override capability for Floor 2 (e.g. to run an
economy-disabled Floor 2 headless comparison), that will require a small,
separate, deliberate change to `initializeFloor2Scenario`'s flag-setting
logic — flagged here as a follow-up, not done in this PR.

## AI-purchasing-consumer note (from plan review)

`headless-runner.ts` unconditionally calls `runSettlementMaintenancePlanner`
every tick while on Floor 2 — this is a real AI consumer of Quartermaster
stock that the initial investigation missed and a plan-review pass caught.
Confirmed this is intentional, bounded (8-iteration cap per tick),
fail-safe (blacklist-and-continue on any decision error), and latch-gated
so it doesn't run every single frame unconditionally. Added a headless test
(above) proving it runs its full decision loop against real live stock
without error across a full run. `validateGeneratedCarryover` does not
require unclaimed registry instances to be claimed, so there's no
orphan-instance-bloat risk from stock the AI declines to purchase.

## Floor 3 caveat

No Floor 3 scenario exists yet, so the carryover-boundary question ("what
happens to unpurchased Floor 2 Quartermaster stock when carrying over to a
hypothetical Floor 3") is currently moot. Flagging this so a future
Floor 3 implementation revisits whether Quartermaster-stock carryover needs
explicit handling (e.g. pruning stale offers vs. carrying them forward).

## Verification

- `tests/integration/floor-transition-carryover.test.ts`,
  `tests/integration/generated-equipment-pipeline.integration.test.ts`,
  `tests/headless/floor2-completion.test.ts`,
  `tests/headless/boss-chest-lifecycle.test.ts` — all pass (16 tests across
  the 4 touched/extended files).
- Floor 1 regression: `tests/unit/loot-tables.test.ts` (8 tests) and
  `tests/headless/floor1-completion.test.ts` (9 tests) — both pass unchanged,
  confirming the Floor 1 equipment-free invariant and win-rate gate are
  untouched by this change.
- `npm run verify:fast` — 700 tests passed, plus physics-defs/size/weight
  coverage checks green.
- Real-artifact observation (not lab-only, per rule #9): reproduced the
  pre-fix `registry-not-empty` crash via `git stash` on the real
  `onFloor1Cleared -> configureWorld` transition path, then confirmed the
  fix resolves it — see "Critical bug found and fixed" above for the exact
  repro/fix evidence.

## Review harness

3🍎 tier. `docs/knowledge/review-ledgers/2026-07-29-floor2-equipment-economy-flag.review-ledger.json`:

- `plan_review`: completed, `gpt-5.5`, `plan_divergence: minor`, 3
  concerns raised and resolved (the AI-purchasing-consumer gap above, an
  evidence request for the purchasing path, and an interactive-UI
  observation request judged sufficiently covered by existing merged
  BossChestUI wiring plus headless evidence for this flag-only change).
- `code_review`: clean after 2 rounds. Round 1 (`claude-sonnet-4.6`) found
  the critical carryover-crash bug and the medium headless-override
  staleness (both above); round 2 (`claude-sonnet-4.6`, independent
  re-review) confirmed both fixes are correct and complete end-to-end, with
  no new concerns.

## Coordination note

A sibling session is concurrently adding Floor 2 achievement content in
`src/shared/achievements.ts`. This PR does not touch that file.

## Unresolved issues / recommended next steps

- None blocking. The two documented gaps above (headless override-clobber
  staleness note, Floor 3 carryover-boundary question) are intentionally
  left as follow-ups, not defects in scope for this PR.
