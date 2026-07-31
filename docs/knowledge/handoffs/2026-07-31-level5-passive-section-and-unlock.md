# Handoff: Level-5 passive section header + unlock announcement (closes #2439)

## Date

2026-07-31

## Persona

UX Designer

## Systems touched

hud-ux, weapons, vfx

## Apples

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎

## Context

Issue #2439 was closed by merged PR #2440, which added passive ability rows,
non-equippability, effect/state/reason text, `createEmptyAbilityState()`, and a
real-pipeline rendered-projection e2e test. Two explicit user requirements were
left unimplemented, and one change in that PR needed to be walked back:

1. Passive rows rendered appended directly after active rows with no distinct
   "PASSIVE" section separating them.
2. No `HudAnnouncementBanner` unlock announcement fired at the level-5 skill
   milestone.
3. **Regression to fix:** PR #2440 broadened `applyPassive()`'s VFX-push
   condition to fire for ALL player passives (removed the prior
   `weaponPrerequisite !== undefined` guard), so activation VFX fired on every
   re-sync/carryover application of ANY passive — misleading, since applying a
   passive on world-load/re-sync is not the same as the player unlocking it.

## What changed

- **`src/game/systems/abilitySystem.ts`** — Restored the
  `def.weaponPrerequisite !== undefined && hasComponent(world.ecs, holderEid, Player)`
  guard around the VFX push in `applyPassive()`. Only weapon-gated passives get
  an "equip flash" VFX from this path now (fires each time the matching weapon
  becomes equipped — that repetition is intentional, it's the "your weapon
  choice activated this" cue).
- **`src/game/systems/skillSystem.ts`** — At the existing level-5 milestone
  grant site (already one-time via `triggeredMilestones`), for a `Player`
  entity only:
  - if the granted passive has **no** `weaponPrerequisite` (a "general"
    passive), push a one-time `weaponAbilityActivate` VFX event (this is now
    its _only_ VFX source, since `applyPassive` no longer fires for
    no-prerequisite passives);
  - regardless of weapon-prerequisite, push a new `skillPassiveUnlocked`
    announcement (`"Passive Unlocked: <name>"`) — an unconditional "you
    unlocked X" fact, decoupled from whether the passive is immediately
    visually active.
  - Mobs (non-`Player` holders leveling skills via the v2 holder-scoped path)
    still get the passive granted but never produce VFX/HUD feedback.
- **`src/shared/announcement-events.ts`** — Extended `AnnouncementKind` with
  `'skillPassiveUnlocked'` and added `SkillPassiveUnlockedAnnouncementEvent`.
- **`src/engine/HudAnnouncementBanner.ts`** — Added `COLORS.unlock`, extended
  the exhaustive `verbForKind`/`colorForKind` switches, and added
  `getCurrentAnnouncement(): { kind, text } | null` — the real rendered
  projection (not `world.announcements` directly) so e2e probes read what the
  player actually sees.
- **`src/engine/HudUI.ts`** — Passthrough for `getCurrentAnnouncement()`.
- **`src/engine/AbilityLoadoutUI.ts`** — Render-loop overlay adds a distinct
  "PASSIVE ABILITIES" section-header row above the non-equippable passive
  rows (only when passives exist), plus `getVisibleSectionHeaderLabel()` for
  e2e assertions on the currently-scrolled-into-view header text.
- **`src/labs/main-scene-probe-lab/index.ts`** — `MainSceneState` extended
  with `abilityLoadoutSectionHeaderLabel` and `currentAnnouncement`, wired
  through the production probe's `getState()`.
- **Tests:**
  - `tests/e2e/main-game-scene-ui-exclusivity.test.ts` — extended the existing
    real-pipeline passive-row test with (a) a `waitForState`-polled assertion
    that the level-5 milestone renders a `skillPassiveUnlocked` HUD
    announcement with the correct ability name, and (b) an assertion that
    `abilityLoadoutSectionHeaderLabel === 'PASSIVE ABILITIES'` once the
    passive row is scrolled into view.
  - `tests/game/weapon-skill-abilities.test.ts` — removed one stale assertion
    written for the now-reverted VFX broadening; added tests for: `applyPassive`
    VFX scoping (no VFX for general passives, VFX for weapon-gated ones), the
    level-5 milestone site pushing exactly one VFX + one announcement for a
    general passive, an announcement-but-no-VFX for a weapon-gated passive at
    grant time, a same-tick double-fire regression (weapon-gated milestone
    with the matching weapon **already equipped**, asserting exactly one VFX +
    one announcement total across both systems), and no VFX/announcement for a
    non-Player (`spawnEnemy`) entity reaching a milestone.
  - `tests/unit/hud-announcement-banner-skill-passive-unlocked.test.ts` (new)
    — focused unit tests for the banner's rendering of the new kind:
    `getCurrentAnnouncement()` returns the exact text, long text isn't
    ellipsized, the accent color differs from `bossAbilityCast`, and mixed
    announcement kinds in the queue don't throw.

## Constraints honored

- No changes to ability/skill grants, prerequisites, stat application,
  values, thresholds, or slot limits — verified by reading the diff (only
  VFX-emission site/scope and new presentation code changed) and by the
  broad regression sweep below.
- Engine/game layer boundaries preserved: `skillSystem.ts` only imports from
  `src/core/`, `src/game/`, `src/shared/`; `HudAnnouncementBanner.ts` has no
  write-back into `world`.
- Reused the existing `src/shared/ability-presentation.ts` catalog introduced
  by #2440 for ability display names — no second catalog authority created.

## Review harness (3🍎 tier)

- **Plan review** (gpt-5.4, high effort, rubber-duck agent): verdict
  `approved_with_changes`, no blocking issues. Reviewer enumerated 3
  alternatives to the VFX-scoping split (all rejected — see ledger notes),
  confirmed the no-grant/prerequisite/stat/threshold/slot-limit constraint was
  honored, and raised 5 non-blocking concerns. Two were addressed before
  coding was considered final: the e2e announcement assertion was changed from
  a single-frame sample to a `waitForState` poll (avoids FIFO-ordering
  flakiness), and a same-tick double-fire regression test was added (weapon
  already equipped at level-5 grant time). `plan_divergence: minor`.
- **Code review** (claude-sonnet-4.6): round 1 clean, zero concerns.
- Ledger: `docs/knowledge/review-ledgers/2026-07-31-level5-passive-section-and-unlock.review-ledger.json`
  (validated: `npm run review:ledger -- validate <path>` ✅).

## Verification

- `npm run typecheck` ✅
- `npm run lint` ✅
- `npx vitest run tests/game/weapon-skill-abilities.test.ts` ✅ 29/29
- `npx vitest run tests/unit/hud-announcement-banner-skill-passive-unlocked.test.ts tests/unit/hud-announcement-banner-cancel.test.ts` ✅ 7/7
- `npx vitest run tests/e2e/main-game-scene-ui-exclusivity.test.ts` ✅ (real Playwright pipeline against `MainGameScene`/`main-scene-probe-lab`)
- `npx vitest run --project unit tests/game/ tests/engine/` ✅ 1082/1082 (broad regression sweep, no simulation-layer drift)
- `npm run verify:fast` ✅
- Re-ran typecheck/lint + targeted unit + e2e suites after `npm run sync:main -- --reason periodic` rebased HEAD onto latest `main` — all green.

## Floor-path wiring proof (maintainer-requested addendum)

`check:wired-systems` only scans exported `*System` symbols under
`src/core/**`/`src/game/**`. Two things in this PR sit outside that net and
needed a different kind of proof:

1. **The lab drives the canonical bootstrap, not a hand-built array.**
   `src/labs/main-scene-probe-lab/index.ts` calls
   `const baseOptions = createFloorMainSceneOptions(floorId);` and then only
   overrides `lightingConfig` on the spread (`{...baseOptions, lightingConfig:
...}`) — there is no hand-built `postSystems`/system array that could drift
   from the real floor bootstrap. This is pre-existing architecture (from
   before this PR); confirmed present at HEAD by direct inspection, not
   changed by this diff.
2. **`buildEntries()` is a plain-function projection callback with no
   `*System` shape, and needs its own floor-path witness.** It's a private
   closure at `src/engine/scenes/MainGameScene.ts` (inside
   `openAbilitiesConfigModal()`, `~lines 2999-3031`) that produces
   `[...activeEntries, ...passiveEntries]` — the contiguous active-then-passive
   ordering the new `AbilityLoadoutUI` section-boundary detection depends on.
   It is not exported and is not a `*System`, so `check:wired-systems`
   structurally cannot see it. The floor-path witness for it is
   **`tests/e2e/main-game-scene-ui-exclusivity.test.ts` →
   `'renders level-5 passive abilities in the loadout projection with
active/inactive status'`**: it boots the real `MainGameScene` via the
   lab's `createFloorMainSceneOptions`-driven bootstrap (not a stub), drives
   the real production input path
   (`mainSceneProbe.queueAbilitiesToggle(page)` → the real
   `openAbilitiesConfigModal()` handler → `buildEntries()`), and asserts on the
   rendered projection (`stateWithHeader.abilityLoadoutSectionHeaderLabel` and
   `state.currentAnnouncement`) rather than on `AbilityState` directly. This
   test is the floor-path witness for `buildEntries()`; see the revert
   witnesses below for direct proof that it actually exercises the real call
   path (reverting either hunk it depends on breaks it).

## Revert-sensitivity witnesses (maintainer-requested; two independent reverts)

Two isolated reverts were performed against the merge-base
(`034ed37bc536eda84f33f96bd59311bfd65a3c2e`) content, one hunk at a time (both
production changes for this PR land in a single commit, so a plain `git
revert` of that commit would have reverted both hunks together — insufficient
for "independent" witnesses). Each file was overwritten with
`git show 034ed37bc:<path> > <path>`, the targeted test(s) were run and the
exact failure captured, then the file was restored with
`git checkout HEAD -- <path>` and the same test(s) re-run to confirm green.

**Witness A — UI section-header hunk alone**
(`src/engine/AbilityLoadoutUI.ts` reverted; `skillSystem.ts`/`abilitySystem.ts`
left at HEAD):

- Named test:
  `tests/e2e/main-game-scene-ui-exclusivity.test.ts > MainGameScene UI
exclusivity > renders level-5 passive abilities in the loadout projection
with active/inactive status`
- Exact failed assertion (line 214):
  ```
  AssertionError: a distinct PASSIVE section header must render above the non-equippable rows: expected null to be 'PASSIVE ABILITIES'
  - Expected: "PASSIVE ABILITIES"
  + Received: null
  ```
- Restored via `git checkout HEAD -- src/engine/AbilityLoadoutUI.ts`; re-ran
  the same test → 2/2 passed (both `|e2e|` and `|e2e-game|` projects).

**Witness B — unlock announcement / VFX hunk alone**
(`src/game/systems/skillSystem.ts` and `src/game/systems/abilitySystem.ts`
reverted together, since they're one conceptual "grant-site feedback" unit;
`AbilityLoadoutUI.ts` left at HEAD):

- Named test file: `tests/game/weapon-skill-abilities.test.ts` — 4 of 29 tests
  failed:
  1. `abilitySystem weapon-prerequisite passive gate > does NOT push
activation VFX for a no-prerequisite passive applied via applyPassive
directly` — `expected true to be false` (line 386; the reverted
     `applyPassive` fires VFX for every passive again, not just weapon-gated
     ones).
  2. `level-5 milestone unlock feedback (VFX + announcement) > pushes exactly
one activation VFX and one skillPassiveUnlocked announcement for a
general passive` — `expected +0 to be 1` (line 420; the milestone site no
     longer pushes the general-passive VFX).
  3. `level-5 milestone unlock feedback (VFX + announcement) > pushes a
skillPassiveUnlocked announcement but NO activation VFX for a
weapon-gated passive at grant time` — `expected undefined to be defined`
     (line 443; no `skillPassiveUnlocked` announcement is pushed at all — the
     kind doesn't exist on the reverted milestone site).
  4. `level-5 milestone unlock feedback (VFX + announcement) > does not
double-fire activation VFX when the matching weapon is already equipped
at grant time` — `expected +0 to be 1` (line 472; no announcement count
     to double-fire-check because the announcement was never pushed).
- Restored via `git checkout HEAD -- src/game/systems/skillSystem.ts
src/game/systems/abilitySystem.ts`; re-ran the same file → 29/29 passed, and
  re-ran the e2e test above → 2/2 passed.

Both witnesses independently confirm each hunk is load-bearing for its own
named assertion, with no cross-hunk masking.

**Witness C — announcement/VFX hunk, consumer-boundary (e2e rendered) proof**
(same revert as Witness B — `skillSystem.ts`/`abilitySystem.ts` reverted
together; `AbilityLoadoutUI.ts` left at HEAD — but this time run against the
real-pipeline e2e test rather than the game-system unit test, so the
rendered-banner projection itself is proven sensitive, not just internal
`world.vfxEvents`/`world.announcements` state):

- Named test:
  `tests/e2e/main-game-scene-ui-exclusivity.test.ts > MainGameScene UI
exclusivity > renders level-5 passive abilities in the loadout projection
with active/inactive status` (both `|e2e|` and `|e2e-game|` projects)
- Exact failure:
  ```
  Error: Timed out waiting for level-5 swordsmanship milestone renders a HUD
  unlock announcement; last state: {..."currentAnnouncement":null...}
  ```
  at `waitForState` (`tests/e2e/helpers/main-scene-probe.ts:277`), called from
  `main-game-scene-ui-exclusivity.test.ts:161`. The assertion is on
  `state.currentAnnouncement` — the real `HudAnnouncementBanner.
getCurrentAnnouncement()` rendered projection surfaced through the production
  probe, not on `world.announcements` or any other producer-side field.
- Restored via `git checkout HEAD -- src/game/systems/skillSystem.ts
src/game/systems/abilitySystem.ts`; re-ran the same test → 20/20 passed
  (both projects).

This closes the gap between Witness B (which only proved the game-system
unit test is revert-sensitive) and the consumer-boundary assertion shape
required for this PR's witnesses generally (matching Witness A, which already
asserted on the rendered section-header label rather than internal state).

## Notes / blockers

None. All design ambiguities were resolved during the plan review; no
open follow-ups beyond what's already noted as accepted trade-offs in the
ledger (banner `getCurrentAnnouncement()` scope for spawner-kind events, and
announcement-queue replay-on-HUD-reconstruction — both pre-existing properties
of the shared announcement queue, unchanged by this PR).
