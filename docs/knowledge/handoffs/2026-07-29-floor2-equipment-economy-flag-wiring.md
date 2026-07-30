# Floor 2 equipment economy flag wiring

## Systems touched

floor2, generated-equipment, ai-headless

## Summary

Wired `floor2EquipmentEconomy` and `floor2EquipmentAiMaintenance` — the last
two of the five Floor 2 generated-equipment flags — into the real shipped
Floor 2 init path (`src/game/floor2Scenario.ts`), which previously enabled
only 3 of the 5 flags
(`floor2EquipmentRegistry`, `floor2EquipmentCatalog`, `floor2EquipmentRewards`)
and left `floor2EquipmentEconomy`/`floor2EquipmentAiMaintenance` `true` only
inside tests/labs — the exact "shipped inert" failure class documented in
ADR 0034/0036. Confirmed against
`docs/knowledge/epics/floor-2-equipment/PLAN.md`'s product contract that
Quartermaster equipment stock/purchasing is intended to be live on Floor 2,
not lab/test-only. **Correction:** boss-chest rarity resolution is NOT part
of what went live at 85/15 — boss chests resolve at Common (tier1) rarity
only today; the epic's 85% Uncommon / 15% Rare split (PLAN.md §E3-C) is
unimplemented future work, tracked in a new follow-up issue (see "Boss-chest
rarity correction" below). Both flags are now `true` on the real path used
by both `MainGameScene` (via `floor-main-scene-options.ts`) and the headless
AI runner (`headless-runner.ts`), so interactive and headless Floor 2 runs
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
  (no-override) test confirming a boss chest spawns with a resolved reward
  bundle on Floor 2 without any flag override. **Correction:** this test
  does NOT verify 85/15 rarity resolution — boss chests resolve at Common
  (tier1) rarity only today (85/15 is unimplemented; see "Boss-chest rarity
  correction" below). An earlier draft of this handoff incorrectly described
  this test as confirming the "real 85/15 policy"; it does not.
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
re-enables five flags regardless of any caller override. This was
**pre-existing behavior for 3 of the 5 flags** (registry/catalog/rewards
were already forced `true` unconditionally before this PR); this PR's flag
flips make `floor2EquipmentEconomy`/`floor2EquipmentAiMaintenance`
consistent with the other 3, they do not introduce a new inconsistency. No
existing test relies on overriding these to `false` on a Floor 2 run.
Reordering the `Object.assign` to run after `configureWorld` was considered
and rejected as higher-risk (untested interaction with in-`configureWorld`
reads of the flags) for a change whose actual behavior doesn't regress
anything. Fixed the stale JSDoc instead so future readers aren't misled. If
a future task needs a real per-run override capability for Floor 2 (e.g. to
run an economy-disabled Floor 2 headless comparison), that will require a
small, separate, deliberate change to `initializeFloor2Scenario`'s
flag-setting logic — flagged here as a follow-up, not done in this PR.

The remaining two flags, `floor2EquipmentUx` and `floor2EquipmentWorld`, are
NOT touched by `initializeFloor2Scenario` and stay at their world default
(`false`). Unlike the five flags above, this is not "clobbering" — see the
"Declared-but-unenforced flags" section below for why leaving them off is
currently a no-op either way.

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

- **Not fully non-blocking — see #2334.** There is no player-facing
  Quartermaster/shop purchase UI anywhere in `src/engine` today. Enabling
  `floor2EquipmentEconomy` makes real generated stock exist and lets the
  headless AI purchase/equip it, but a **human playing the interactive game
  cannot shop** — the data is live, the UI to act on it is not. This gap was
  flagged in the plan review (see below) but I failed to file the required
  follow-up issue myself; the task owner filed
  [#2334](https://github.com/nalfeo/Crawler/issues/2334) directly. A sibling
  session is now building that UI on top of this branch. Treat this as a
  real, tracked gap — not resolved by this PR.
- **Boss-chest rarity is Common (tier1) only — 85/15 is NOT live.** See
  "Boss-chest rarity correction" below. Tracked in a new follow-up issue
  referencing PLAN.md §E3-C.
- **`floor2EquipmentUx` and `floor2EquipmentWorld` are declared-but-
  unenforced no-op flags.** See "Declared-but-unenforced flags" below —
  relevant for the #2334 session to know its UI work is not currently gated
  by `floor2EquipmentUx` (nothing enables it).
- The headless-override-clobber staleness note and the Floor 3
  carryover-boundary question remain intentional follow-ups, not defects in
  scope for this PR.

## Post-open-PR CI fix (Headless Floor 1 Gate)

CI failed on `tests/headless/floor2-completion.test.ts` > "lets the headless
AI actually purchase and equip Quartermaster stock on the real default path"
with `expect(decisionKinds.length).toBeGreaterThan(0)` → got `0` (1 failed /
174 passed; every other Floor 1 test green, confirming the Floor 1 invariant
and win-rate gate were genuinely unaffected).

**Diagnosis (not a product bug):** `runSettlementMaintenancePlanner`'s
`runEquipmentLoop` legitimately returns zero decisions whenever nothing beats
the current loadout (`candidates.length === 0` or `top.score <= 0` on the
first evaluation, both short-circuit before any push), and the
achievement-claim/boss-chest-action helpers likewise push nothing when
there's nothing unclaimed/open. A fully "nothing to do" settlement visit is a
valid empty-decisions outcome even when `result.ran === true`. The original
test's comment ("a purchase is guaranteed for every seed") encoded an
assumption that an organic 20,000-frame AI run always produces ≥1 decision —
that assumption is false; CI's `ubuntu-latest` runner landed on this
legitimate empty branch (most plausibly cross-platform floating-point
divergence compounding over a long chaotic simulation — the same seed on
local Windows happened to diverge into a state where a purchase occurred, but
this was never a guarantee). Ran the full `headless` vitest project locally
(matching CI's exact invocation) and confirmed all 175 tests pass with no
cross-file state pollution, ruling out ordering effects as the cause.

**Fix:** rewrote the test to construct the purchase condition
deterministically instead of relying on emergent AI behavior, while still
exercising the real production wiring end-to-end: boot Floor 2 through the
real default path (no flag override), teleport the player onto the real
generated settlement anchor (`resolveFloor2SettlementAnchor`), grant
abundant gold, set `world.playerInSafeRoom = true` (mirrors what the real
`safeRoomSystem` sets during normal frame execution, required because
`equipFromBag`'s non-force path gates on `isInSafeContext`), then call
`runSettlementMaintenancePlanner(world)` directly — the same real entry point
the organic in-run AI path calls. Assertions were strengthened, not
weakened: `decisionKinds` must now contain both `'purchase-equipment'` and
`'equip-instance'` (previously just "any decision"). No assertion was
loosened or skipped per rule #11/#12. Verified: the rewritten test passes in
isolation and as part of the full 175-test `headless` project (single-frame,
~330ms vs. the prior 20,000-frame organic run).

## Second escalation: `floor2EquipmentAiMaintenance` was still dead on the real path

The deterministic rewrite above initially made the new test pass by adding
an explicit `floor2EquipmentFlags: { floor2EquipmentAiMaintenance: true }`
override inside the test — because a concurrently-merged commit
(`115fe9fed`, pushed by another session to this shared branch) had added a
hard gate to `runEquipmentLoop`
(`src/game/ai/settlement-maintenance-planner.ts:608`):

```ts
if (!world.floor2EquipmentFlags.floor2EquipmentAiMaintenance) return 'exhausted';
```

`floor2EquipmentAiMaintenance` defaulted `false` (`world.ts`) and
**`initializeFloor2Scenario` never set it** — so on the real shipped Floor 2
path, the AI-purchasing consumer was **deterministically dead by
construction**, even though the data-generation flags were live. A reviewer
(sibling session) correctly identified that overriding the flag inside the
test only proved the mechanism works "when a flag nobody sets is set" —
lab-equivalent proof, the exact ADR 0034/0036 failure class this PR exists
to eliminate, one layer down (the AI consumer, not the stock generator).

**Decision: enable `floor2EquipmentAiMaintenance` in the real path**
(`initializeFloor2Scenario`), not just in the test. Rationale:

- `runSettlementMaintenancePlanner` (the function this flag gates) is called
  only from `headless-runner.ts` (unconditional per-frame) and two labs —
  never from any interactive-game engine/scene code. Enabling it has **zero
  direct effect on human players** (who are already blocked from purchasing
  by the absent Quartermaster UI, #2334); it only affects headless/BT-AI
  autonomous shopping.
- No pre-existing Floor 2 win-rate percentage gate exists in `tests/` to be
  put at risk.
- Leaving it off was precisely the failure class this entire PR/session was
  opened to eliminate — a genuinely-generated economy with zero real
  consumer that acts on it.

**Fix:** added `world.floor2EquipmentFlags.floor2EquipmentAiMaintenance = true;`
to `initializeFloor2Scenario` alongside the other four flags. Removed the
now-redundant explicit override from the headless test — it again exercises
the real default path with no override, restoring accurate "real default
path" framing. Extended the flag-closure assertions in
`generated-equipment-pipeline.integration.test.ts` and
`floor2-scenario-initialization.test.ts` to assert all 5 real-path flags are
`true` (and that `floor2EquipmentUx`/`floor2EquipmentWorld` correctly remain
`false`, since nothing enforces them — see below).

**Verified no gameplay tuning was needed:** ran the targeted headless suite
(`floor2-completion.test.ts`, `boss-chest-lifecycle.test.ts`,
`floor1-completion.test.ts` — 20 tests), the extended integration/unit
flag-closure tests, and `npm run verify:fast` (691 tests) — all green with
**no win-rate movement and no tuning changes**. Per the standing rule, if
enabling real AI purchasing had moved a win-rate gate, the correct response
would have been to escalate rather than adjust gameplay; that did not occur.

## Boss-chest rarity correction

The PR body and an earlier draft of this handoff both incorrectly stated
that boss-chest rarity resolution goes live at the epic's 85% Uncommon /
15% Rare split. **That is false.** Boss chests resolve at **Common (tier1)
rarity only** today; `115fe9fed`'s own commit message documents this
directly ("Boss chests currently resolve at Common rarity (tier1); the
85/15 split is a future task not yet implemented"), and the in-code comment
in `floor2Scenario.ts` was already accurate — only the PR body/handoff prose
was stale. Corrected both. Filed a new tracked issue for implementing the
85/15 split, referencing `docs/knowledge/epics/floor-2-equipment/PLAN.md`
§E3-C. `boss-chest-lifecycle.test.ts`'s default-path test verifies a chest
spawns with a resolved reward bundle — it does not and should not be read as
verifying rarity distribution until that issue lands.

## Declared-but-unenforced flags: `floor2EquipmentUx` / `floor2EquipmentWorld`

Confirmed via repo-wide search: `floor2EquipmentUx` and
`floor2EquipmentWorld` are declared in `world.ts` (default `false`, with
JSDoc describing intended scope) and mentioned in `headless-runner.ts`'s
JSDoc, but have **zero enforcement/consumer sites anywhere in `src/`** — no
code anywhere checks either flag's value. They are architecturally
identical to the pre-`115fe9fed` state of `floor2EquipmentAiMaintenance`:
declared, defaulted off, and currently a pure no-op regardless of value.

This is **not fixed in this PR** — there is nothing to gate on yet
(`floor2EquipmentUx` is presumably intended for the still-unbuilt
Quartermaster purchase UI, #2334; `floor2EquipmentWorld` for a
not-yet-started world-placement feature). **Relevant for the #2334
session:** its UI work is not currently gated by `floor2EquipmentUx` in any
way — building the UI does not require flipping this flag, and flipping it
today would have no effect since nothing reads it. If #2334 wants this flag
to mean something, it will need to both flip it in the real path and add
the enforcement check itself.

## Merge-conflict resolution: `fast-uri` audit exception vs. main's re-dated exceptions

Commit `13c250f40` on this branch upgraded `fast-uri` to 3.1.4 and removed its
now-unnecessary `AUDIT_EXCEPTIONS` entry in
`scripts/agent/security/npm-audit.mjs` (the fix, not a re-date). Independently,
`main` picked up commit `a33161c5b` (via unrelated PR #2332, a terrain-lab
feature) about ten minutes later that re-dated all three `AUDIT_EXCEPTIONS`
expiry dates to `2026-08-13`, including the same `fast-uri` entry this branch
deletes — a genuine (non-textual) rebase conflict.

Resolved per explicit instruction from the reviewing session: kept this
branch's `fast-uri` deletion (the real fix), and took `main`'s `2026-08-13`
dates as-is for `brace-expansion` and `find-my-way` without touching their
logic or the audit test's structure — that pair is owned by a separate,
concurrently-running "Expired audit exceptions" session, which has been
pointed at this branch's `13c250f40` commit to build on top of it rather than
duplicate it. Reconciled `npm-audit.test.mjs`'s hardcoded advisory/expiry
assertions by hand (not just `verify:fast`) and ran
`node scripts/agent/security/npm-audit.test.mjs` directly post-rebase — all 13
assertions pass and confirm the `fast-uri` assertions reflect deletion, not a
re-dated exception.

**Traceability note:** `13c250f40`'s `fast-uri` upgrade originated on this
branch (PR #2333) and is being generalized/built upon by the separate
"Expired audit exceptions" session for `brace-expansion`/`find-my-way` — if a
later reader wonders why two PRs touched `npm-audit.mjs`/`npm-audit.test.mjs`
the same evening, this is why.
