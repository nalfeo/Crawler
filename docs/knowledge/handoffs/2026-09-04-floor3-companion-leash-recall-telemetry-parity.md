# Floor 3 companion experience: leash recall, AI Runner telemetry parity, Command explainer

## Date

2026-09-04

## Persona

Game AI Engineer (companion AI + AI Runner lab), coordinating the UX seam
(`MainGameScene.ts` Command-button explainer) within this one session rather
than splitting publication, per the cross-cutting slice instruction.

## Systems touched

ai-behavior-tree, enemies, hud-ux

## Apples

4🍎 estimated, 4🍎 actual (exact) — **estimate declared late.** Per explicit
coordinator correction: this session did not declare its apple estimate at
kickoff as AGENTS.md Quick Start step 4 requires; it was corrected mid-session
to 4🍎 by the coordinating session. Recording this honestly rather than
implying compliant kickoff timing.

## Summary

Implements a coherent Floor 3 companion-experience slice covering three
related issues (see ADR 0104 for the full design rationale):

- **#4205** — AI Runner lab now exposes each companion's current decision and
  path with parity to the existing player telemetry/overlay.
- **#4206** — companions that drift arbitrarily far from the player during
  combat chaining now get a bounded, edge-triggered recall opportunity via a
  sustained-away-streak counter, using only existing tuning constants (no new
  balance value invented).
- **#4209** — the `⚡ Command` HUD button now explains itself via a one-time
  toast the first time it unlocks, mirroring the existing Abilities-unlock
  pattern.

**#4204** (Floor 3 occasionally skipped the starter-companion choice) is
**not** part of this PR. It was already fixed by merged PR #4183 and is closed
separately with its own evidence — the new PR closes only #4205, #4206, and
#4209.

This branch was found to be 8 commits behind `origin/main` mid-session (all
prior "work" was uncommitted working-tree diff, zero real commits). WIP was
committed, then `origin/main` was merged in with zero conflicts; all
post-merge regression suites were re-verified against the merged code (see
Verification run below) rather than trusting any pre-merge test result.

## Files touched

- `src/game/systems/companionAISystem.ts`
  - Adds `awayStreakByWorld: WeakMap<GameWorld, Map<number, number>>` tracking
    consecutive frames a player-team companion has spent beyond the existing
    self-anchored engagement range from the player.
  - Once the streak exceeds the existing `tuning.floor3Companion.engagementEndFrames`
    constant, the stale-lock **continuation** check (only) is skipped exactly
    once (edge-triggered), then the counter resets. Fresh acquisition is never
    gated and remains fully self-anchored/unconditional.
  - `resetCompanionAIState()` now also clears `awayStreakByWorld`.
  - **Review fix:** the recall condition is additionally gated on
    `world.floorId === 'floor3'` — `companionAISystem.ts` is shared by other
    floors (e.g. Floor 4), so an ungated recall would have been a silent
    cross-floor balance change.
- `tests/ecs/companion-ai-system.test.ts`
  - Replaces 3 outdated regression tests (written against an earlier, abandoned
    design) with new tests in `describe('sustained-drift stale-lock recall
(regression, #4206)')`: fresh-acquisition stays self-anchored even far from
    the player; a stale lock holds before the grace window elapses; the streak
    counter resets once back in range; NPC-owned (non-player) rosters never
    accumulate a drift streak.
  - **Review fix:** replaced the original "recovers to follow" test (which the
    self-anchored range check alone already explained, making it worthless as
    feature-specific proof) with two tests that actually isolate the new
    logic: one keeps the original rival in self-anchored range throughout and
    introduces a strictly-nearer second rival exactly at the edge-trigger
    frame, asserting the decision switches (proving the recall genuinely
    fired); the other proves the same scenario never breaks the lock outside
    Floor 3 (Floor 4 stays byte-identical to clean-main).
- `src/labs/ai-runner-lab/index.ts`
  - Adds `getCompanionTelemetry()` (per-companion decision/path fields
    mirroring the player's own telemetry shape), `drawCompanionOverlay()`
    (visual parity overlay), and `getFloor3LossReason()` (distinguishes
    `party-wiped`/`timeout`/`player-hp` game-over causes). Reuses the
    `AiRunnerDebugSnapshot`/`floor3SurfaceTrace` infrastructure merged in PR
    #4183 rather than reimplementing it.
  - **Review fix (visible parity):** the original cut only exposed companion
    telemetry via canvas overlay geometry and a pull-based debug snapshot —
    not an actual visible UI element, so "parity with the player path
    visualization" wasn't backed by anything readable. Added a visible
    `#ai-companions` cell to the existing Decision-telemetry panel, refreshed
    every render tick from the same `getCompanionTelemetry()` data.
  - **Review fix (loss-reason gating/ordering):** `getFloor3LossReason()` now
    returns `null` when `world.floorId !== 'floor3'` (matching its own doc
    comment), and checks the player's own HP
    (`world.stores.health.current[playerEid] <= 0`) **before** the party-wipe
    check, fixing a misclassification of simultaneous player-death +
    party-wipe frames as `party-wiped` instead of `player-hp`.
- `src/engine/scenes/MainGameScene.ts`
  - Adds `floor3CommandUnlockNotified` latch + one-time `flashHint` explainer
    toast shown the first time `floor3PartyAvailable` becomes true.
  - **Review fix:** tightened the toast condition to also require
    `!this.isBlockingSurfaceOpen()` and
    `resolvePartyMemberEids(this.world).length > 0` — the original condition
    fired on floor-check alone, not actual companion-party availability, and
    could fire while a dialog/menu was open.
- `src/labs/main-scene-probe-lab/index.ts`
  - Adds a `floor3CommandUnlockNotified` probe field so e2e tests can assert
    the toast latch reliably. (The shared `interactionHint` text/visibility
    slot is clobbered every frame by unrelated NPC-proximity logic in
    `updateInteractions()`, so asserting on rendered toast text directly is
    flaky — this is a pre-existing, out-of-scope limitation affecting all
    `flashHint`-based unlock toasts, not something this PR fixes.)
- `tests/unit/main-game-scene-mobile-ui.test.ts`
  - Asserts the explainer latch/text and its wiring to the Command button and
    `[C]` key binding, updated for the tightened gating condition.
- `tests/e2e/main-game-scene-floor3-party-ux.test.ts`
  - New real-scene regression: the toast does NOT fire during the
    loadout/starter-picker phase, and DOES fire once a companion is recruited
    and no blocking surface remains (via the new probe latch).
- `tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts`
  - Asserts a companion telemetry sample appears after starter-companion
    confirmation with `kind`/`x`/`y`/`targetX`/`targetY`/`targetDist`/`path` all
    populated and finite/non-empty.
  - **Review fix:** additionally asserts the actual rendered `#ai-companions`
    DOM cell text (not just the internal snapshot) contains the live
    companion's eid and matches `/pt path/`, reading a fresh snapshot at that
    point to avoid brittleness from Floor 3's companion-swap surface.
- `tests/unit/ai-runner-companion-parity-wiring.test.ts` (new)
  - 4 source-string canary tests covering the visible `#ai-companions` cell
    wiring and the `getFloor3LossReason()` floor-gate/ordering fix.

## Real artifact evidence

- **#4206 (before):** headless Floor 3 run ended in `timeout` (or, in earlier
  attempted designs, `death`) once a companion chained combat far enough from
  the player — reproduced across 3 distinct failed intervention designs before
  the accepted one, each diagnosed via the real headless pipeline
  (`tests/headless/floor3-completion.test.ts`), not synthetic assertions.
- **#4206 (after):** real headless Floor 3 completion test passes with
  `outcome: 'victory'` — all 6 studios cleared, all 4 Final Four rounds won,
  companion kept, exit confirmed.
- **#4205 (before/after):** the real e2e scene
  (`tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts`) now
  observes a populated companion telemetry sample (decision/path fields) in the
  live AI Runner Lab scene after starter-companion confirmation, where
  previously only player telemetry existed.
- **#4209 (before/after):** `tests/unit/main-game-scene-mobile-ui.test.ts`
  exercises the real `MainGameScene` toast-latch wiring; the explainer now
  fires exactly once on first Command-button availability, matching the
  existing Abilities-unlock UX pattern already shipped for consistency.

## Verification run

- `npx vitest run tests/ecs/companion-ai-system.test.ts --project unit`: 11/11
  passed (including the review-driven edge-trigger-proof and Floor-4
  non-regression tests).
- `npx vitest run tests/unit/main-game-scene-mobile-ui.test.ts --project unit`:
  15/15 passed.
- `npx vitest run tests/unit/ai-runner-companion-parity-wiring.test.ts --project unit`:
  4/4 passed (new canary tests for the visible telemetry + loss-reason fixes).
- `npx vitest run tests/headless/floor3-completion.test.ts --project headless`:
  passed, `outcome: 'victory'`, re-run after all review fixes.
- `npx vitest run tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts --project e2e`:
  passed (~54s), re-run fresh after all review fixes (mandatory hard-gate
  requirement — not weakened in any way), including the new `#ai-companions`
  DOM assertion.
- `npx vitest run tests/e2e/main-game-scene-floor3-party-ux.test.ts --project e2e`:
  passed (~9.3s).
- `npm run typecheck`: clean (one transient template-literal/backtick syntax
  bug introduced while adding an HTML comment inside the `ai-runner-lab`
  template literal was caught and fixed here).
- Lint (`eslint`) and Prettier: clean on all touched files.
- `npm run verify:fast` and `npm run verify:pr-prereqs`: passed.

## Review threads addressed

GitHub's automated `copilot-pull-request-reviewer` flagged 5 substantive
threads on PR #4235, all fixed with real code changes (not suppressed/
allowlisted) and verified before reply:

1. **#4209 toast over-fired** — gated only on `floorId==='floor3'`, not actual
   party availability. Fixed: added `!isBlockingSurfaceOpen()` +
   `resolvePartyMemberEids(...).length > 0`.
2. **#4206 recall not floor-scoped (major)** — silently changed Floor 4
   behavior. Fixed: added `world.floorId === 'floor3'` gate.
3. **#4205 "parity" not backed by visible UI** — only internal
   overlay/snapshot data existed. Fixed: added the visible `#ai-companions`
   DOM cell.
4. **`getFloor3LossReason()` floor-gate + ordering bug** — didn't gate on
   floorId, misclassified simultaneous player-death + party-wipe. Fixed both.
5. **#4206 regression test didn't isolate the new logic** — the pre-existing
   self-anchored range check alone explained the assertions. Fixed: rewrote to
   an edge-trigger-substitution proof plus a Floor-4 non-regression proof.

## Unresolved issues

- The #4206 recall mechanism is a deliberate best-effort design, not an
  airtight guarantee — see ADR 0104 "Known limitation" and "Risks" for the
  accepted pathological-cluster boundary case and why stronger interventions
  were rejected (each caused real companion deaths in the headless pipeline).
- #4204 is intentionally out of scope for this PR; it is closed separately
  citing merged PR #4183 as evidence.
- No unrelated Floor 3 balance tuning, enemy-AI redesign, or broader HUD
  redesign was made, per the explicit non-goals.

## Follow-up: Floor 3 wild hostility design tweak

Human follow-up on PR #4235 changed the scope from documentation-only to a
runtime mechanics update:

- Floor 3 wild mobs are no longer globally hostile. They become hostile only
  while the player is within `tuning.floor3Companion.wildAggroRangeFt`.
- The initial aggro range is 30 ft, derived from 3/4 of the normal horizontal
  screen radius (`1280px / zoom 2 / 8px-per-foot = 80ft` visible width → 40ft
  radius → 30ft).
- Active wild mobs stay hostile through a hysteresis band, then disengage when
  the player is more than `2 * wildAggroRangeFt` away.
- Disengaging wild mobs heal to full health.
- Player Companions target hostile wild mobs only; neutral/disengaged wilds are
  ignored. Trainer/Studio/Final-Four opposing Companions remain valid rival
  targets.

Implementation notes:

- `src/game/systems/floor3WildHostility.ts` owns the player-anchored hostile set
  in `world.floorExtendedState.floor3HostileWildEnemyEids`.
- `companionAISystem` updates that set before choosing targets, matching the
  real Floor 3 system order where companion decisions must be available before
  wild redirection and companion combat.
- `floor3WildTargetRedirectSystem` redirects only hostile wild mobs toward party
  Companions.
- `enemyAISystem` idles non-hostile Floor 3 wild mobs, preventing the generic
  player-aggro path from bypassing the new contract.
- `isEnemyHostileToPlayer` now returns false for neutral Floor 3 wild mobs so
  weapon/spell/homing target consumers agree with companion AI.
- The official mechanics docs were updated in both
  `docs/knowledge/game-design/floor3-companion-league.md` and
  `.specify/specs/floor3-companion-league.md`.

Additional verification for the follow-up:

- `npx vitest run tests/game/floor3-companion-combat.test.ts tests/ecs/companion-ai-system.test.ts --project unit`:
  17/17 passed.
- `npx vitest run tests/unit/floor3-overworld.test.ts tests/game/progression-effects-coverage.test.ts tests/ecs/homing-system.test.ts --project unit`:
  38/38 passed.
- `npm run typecheck`: clean.
- `npm run lint -- src/core/world.ts src/core/enemy-targeting.ts src/game/systems/floor3WildHostility.ts src/game/systems/companionAISystem.ts src/game/systems/floor3WildTargetRedirectSystem.ts src/game/enemyAISystem.ts src/game/floor3Scenario.ts tests/ecs/companion-ai-system.test.ts tests/game/floor3-companion-combat.test.ts`:
  clean.
- Prettier check on all touched runtime/test/doc files: clean.
- Follow-up apple metric:
  `docs/knowledge/metrics/apples/2026-09-04-floor3-wild-hostility.json` (3🍎
  estimated, 3🍎 actual, exact).

## Follow-up: Headless Floor 1 Gate CI recovery

CI later failed the `Headless Floor 1 Gate` job on PR head `8812698`, but the
failing assertion was the Floor 3 production completion test:

- `tests/headless/floor3-completion.test.ts` reproduced locally as a deterministic
  timeout at frame 54,000.
- The run cleared five Studios but stalled on Skyroot with one live Studio rival
  Companion displaced far from the room anchor and one player Companion knocked
  out.
- Root cause: `findFloor3ProgressObjective()` routed partial party KOs to
  `resolveNearestSafeAnchor()` even though production Floor 3 does not spawn
  `RallyPoint` entities. `companionKOSystem` only revives at actual
  `RallyPoint`s, so the AI could repeatedly stand at a safe-room anchor without
  recovering the party or finishing the displaced rival.

Fix:

- `src/game/ai/bt-ai-provider.ts` now routes Floor 3 recovery only to an actual
  nearest `RallyPoint` entity. If no RallyPoint exists, encounter progress
  continues instead of dead-routing to a generic safe anchor.
- Floor 3 encounter progress now prefers a reachable live encounter enemy before
  falling back to the static room anchor, so a displaced last rival can be
  chased instead of leaving the AI staged at an empty Studio center.

Verification:

- `npx vitest run tests/headless/floor3-completion.test.ts --project headless`:
  passed.
- `npx vitest run tests/game/floor3-companion-combat.test.ts tests/ecs/companion-ai-system.test.ts --project unit`:
  17/17 passed.
