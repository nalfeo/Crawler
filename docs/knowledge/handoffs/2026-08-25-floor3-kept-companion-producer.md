# Session Handoff: Floor 3 Slice 11 — kept-companion persistence producer contract

## Date

2026-08-25

## Persona

Producer → (game/shared implementation)

## Systems touched

enemies, inventory, quests

## Apples

2🍎 (per the spec's own slice-table rating). Below the ≥3🍎 review-ledger
threshold (repo rule #13), so no review ledger or apple-metrics JSON was
recorded for this session.

## What Was Done

Implemented nalfeo/Crawler#3536 (Floor 3 Slice 11), blocked-by/child of the
Floor 3 Companion League epic (#3529). Added the **producer** side of
`KeptCompanionContract` on the Floor 3 floor-transition carryover channel plus
the end-of-floor picker hook. Floor 4+ **consumption** of this contract (to
re-host the kept Companion) is an explicitly separate, out-of-scope epic
concern per the issue.

- New `src/shared/data/floor3/kept-companion-contract.ts`: defines
  `KEPT_COMPANION_CONTRACT_SCHEMA_VERSION`, the `KeptCompanionContract`
  interface (`schemaVersion`, `speciesId`, `affinity`, `fightingStyle`,
  `form: 2`, `levelBand: 'floor3-graduate'`, `learnedAbilityIds`), and
  `buildKeptCompanionContract(species)` — always resolves the **full**
  milestone ability set (`ABILITY_MILESTONE_LEVELS`'s max level), per spec R7
  §9.3 / ADR 0071 D6: the kept Companion is always promoted to its
  ultimate/adult form regardless of the level it actually reached in-run.
- `Floor3StudiosState.keptCompanionEid?: number` (`src/shared/floor-types.ts`)
  holds the current pick between victory and floor-transition capture.
- `src/game/floor3Scenario.ts`: `autoDefaultFloor3KeptCompanion` auto-picks the
  player's first party slot (lowest `PartySlot.slot`) the instant
  `latchFloor3Victory` fires, so every run always carries a deterministic pick
  even before the future picker UI (slice 14) exists. Exported
  `selectFloor3KeptCompanion(world, partyEid): boolean` is the end-of-floor
  picker hook itself — validates victory has latched and `partyEid` is a live
  Companion + PartySlot on `TeamId.PLAYER`, returns `false` (no-op) otherwise.
- `src/game/playerCarryover.ts` (the carryover channel):
  - Added `keptCompanion?: KeptCompanionContract` to `PlayerCarryoverSnapshot`.
  - `capturePlayerCarryover` resolves it via a new
    `resolveFloor3KeptCompanionContract(world)` helper that reads
    `world.floorExtendedState?.floor3Studios?.keptCompanionEid` and the ECS
    `companion` store **directly**, rather than importing a resolver from
    `floor3Scenario.ts` — `floor3Scenario.ts` already imports
    `restorePlayerCarryover`/`PlayerCarryoverSnapshot` from
    `playerCarryover.ts`, so importing back would create a cycle.
  - `assertKeptCompanionContract` fail-closed validation (schema version,
    speciesId, affinity/fightingStyle enum membership, `form === 2`,
    `levelBand === 'floor3-graduate'`, `learnedAbilityIds` unique-string array)
    is wired into `normalizePlayerCarryoverSnapshot`, so a malformed persisted
    `keptCompanion` throws `PlayerCarryoverSnapshotError` before any mutation —
    consistent with every other carryover field's fail-closed contract.
- Tests: `tests/unit/floor3-victory-system.test.ts` gained coverage for
  auto-default-on-victory, override via `selectFloor3KeptCompanion`, no-op
  before victory / on an invalid entity, and `capturePlayerCarryover` producing
  a valid contract end-to-end from a real Floor 3 victory. Added
  `tests/unit/player-carryover.test.ts` coverage for fail-closed validation on
  every malformed-`keptCompanion` shape (wrong schema version, non-string
  speciesId, invalid affinity/fightingStyle, wrong form, wrong levelBand,
  non-array/non-string/duplicate `learnedAbilityIds`, non-object
  `keptCompanion`) plus a happy-path restore.

Verified via `npm run typecheck`, `npm run lint` (both clean, 0 warnings), and
targeted `npx vitest run` on `floor3-victory-system.test.ts` (20/20),
`floor3-overworld.test.ts` (12/12, unrelated regression check), and
`player-carryover.test.ts` (58/58) — 90/90 total.

## Key Decisions Made

- **Avoided a `playerCarryover.ts` <-> `floor3Scenario.ts` import cycle** by
  having `playerCarryover.ts` read Floor 3 state directly
  (`world.floorExtendedState.floor3Studios.keptCompanionEid` + the ECS
  `companion` store) and resolve species via `speciesForToken` from
  `shared/data/floor3` (a leaf module with no game-layer dependencies),
  instead of importing a resolver function from `floor3Scenario.ts`. This
  mirrors the existing pattern for equipment/boss-chest carryover, which also
  reads world state directly rather than through scenario-file imports.
- **Ability-set derivation for the "ultimate form" rule**: interpreted spec R7
  §9.3 / ADR 0071 D6's "always kept at ultimate form" as meaning
  `learnedAbilityIds` includes every milestone ability
  (`ABILITY_MILESTONE_LEVELS[last]` = level 34), not just the abilities the
  Companion had actually earned by its real end-of-run level. This is the one
  judgment call in this slice most worth double-checking against later
  slice-14 (picker UI) or Floor 4-consumption feedback, since the spec doesn't
  spell out ability-set derivation explicitly — flagging here for visibility.
- **Auto-default hook point**: chose `latchFloor3Victory` (inside
  `floor3ObjectiveTick`) over the actual floor-transition capture point
  (`confirmFloor3StairDescend` → `capturePlayerCarryover`), because party
  entities are guaranteed alive in the ECS at victory-latch time, and this
  gives `selectFloor3KeptCompanion` (and the future picker UI) a real window
  to override the pick before capture — matching `selectFloor3StarterCompanion`'s
  established "pure state-mutation function, no UI" pattern.
- **2🍎 apple estimate**: matches the spec's own slice-table rating for slice
  11; below the ≥3🍎 review-harness/ledger threshold (repo rule #13), so this
  session ran only the standard `code_review` + `codeql_checker` gates rather
  than the full ledger process.

## What's Next / Blockers

None blocking for this slice. Explicitly out of scope (separate, later work):

- Floor 3 Slice 14: the actual keep-companion **picker UI** — this session
  only wires the underlying `selectFloor3KeptCompanion` state-mutation hook,
  not any scene/engine-level UI.
- Floor 4+ **consumption** of the persisted `KeptCompanionContract` to
  actually re-host the kept Companion on a later floor — a separate epic
  concern per the issue text ("Floor 4+ consumption remains a separate epic
  concern").
- Worth a follow-up sanity check once the picker UI (slice 14) or Floor 4
  consumption lands: confirm the "always full ultimate-form ability set"
  interpretation above matches the intended design, since it wasn't spelled
  out explicitly in the spec/ADR.

## Retrospective

### Lessons Learned

- `bitecs` 0.4's `hasComponent` signature is `(world, eid, component)` — worth
  noting since an automated code-review pass flagged this call order as
  swapped in this PR's `playerCarryover.ts`/`floor3Scenario.ts` usage; verified
  against `node_modules/bitecs/dist/core/Component.d.ts` and every other
  existing call site in the codebase (e.g. `src/core/apply-damage.ts`) and
  confirmed the `(world, eid, component)` order used here is correct — the
  review comment was a false positive.
- `noUncheckedIndexedAccess` bites even on `as const` tuple literals indexed
  by a computed expression (`ABILITY_MILESTONE_LEVELS[length - 1]`) — TS
  widens the result to `T | undefined` regardless of the array being a fixed
  known-length const tuple. Fixed with an explicit `?? 0` fallback typed as
  `number` rather than a non-null assertion, since a defensive fallback reads
  more honestly here than asserting on TS's blind spot.

### Mistakes Made

- First draft of the fail-closed validation test used `affinity: 'fire'` /
  `fightingStyle: 'brawler'` as the "valid" fixture values without checking
  `AFFINITY_RING`/`FIGHTING_STYLES` first — those aren't real values in this
  codebase (`ember`/`charger` are). Caught immediately by the test's own
  happy-path assertion failing; fixed by reading `affinity.ts`/`styles.ts`
  directly instead of guessing plausible-sounding fantasy-genre names.

### Opportunities for Future Improvement

- If Floor 3 Companion League handoffs keep accumulating under the imprecise
  `enemies`/`quests`/`inventory` buckets (this is at least the third such
  handoff), consider adding a dedicated `companions`/`floor3-league` slug to
  `docs/systems/README.md` per the prior session's same suggestion.
