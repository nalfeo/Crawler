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

## Notes / blockers

None. All design ambiguities were resolved during the plan review; no
open follow-ups beyond what's already noted as accepted trade-offs in the
ledger (banner `getCurrentAnnouncement()` scope for spawner-kind events, and
announcement-queue replay-on-HUD-reconstruction — both pre-existing properties
of the shared announcement queue, unchanged by this PR).
