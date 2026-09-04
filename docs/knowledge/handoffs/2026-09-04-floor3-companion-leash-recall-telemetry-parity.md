# Floor 3 companion experience: leash recall, AI Runner telemetry parity, Command explainer

## Date

2026-09-04

## Persona

Game AI Engineer (companion AI + AI Runner lab), coordinating the UX seam
(`MainGameScene.ts` Command-button explainer) within this one session rather
than splitting publication, per the cross-cutting slice instruction.

## Systems touched

ai-behavior-tree, hud-ux

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
- `tests/ecs/companion-ai-system.test.ts`
  - Replaces 3 outdated regression tests (written against an earlier, abandoned
    design) with 5 new tests in `describe('sustained-drift stale-lock recall
(regression, #4206)')`: fresh-acquisition stays self-anchored even far from
    the player; a stale lock holds before the grace window elapses; a stale
    lock drops once the grace window is exceeded and recovers to `follow` when
    nothing is left nearby; the streak counter resets once back in range;
    NPC-owned (non-player) rosters never accumulate a drift streak.
- `src/labs/ai-runner-lab/index.ts`
  - Adds `getCompanionTelemetry()` (per-companion decision/path fields
    mirroring the player's own telemetry shape), `drawCompanionOverlay()`
    (visual parity overlay), and `getFloor3LossReason()` (distinguishes
    `party-wiped`/`timeout`/`player-hp` game-over causes). Reuses the
    `AiRunnerDebugSnapshot`/`floor3SurfaceTrace` infrastructure merged in PR
    #4183 rather than reimplementing it.
- `src/engine/scenes/MainGameScene.ts`
  - Adds `floor3CommandUnlockNotified` latch + one-time `flashHint` explainer
    toast shown the first time `floor3PartyAvailable` becomes true.
- `tests/unit/main-game-scene-mobile-ui.test.ts`
  - Asserts the explainer latch/text and its wiring to the Command button and
    `[C]` key binding.
- `tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts`
  - Asserts a companion telemetry sample appears after starter-companion
    confirmation with `kind`/`x`/`y`/`targetX`/`targetY`/`targetDist`/`path` all
    populated and finite/non-empty.

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

- `npx vitest run tests/ecs/companion-ai-system.test.ts --project unit`: 10/10
  passed (5 original + 5 rewritten #4206 regression tests).
- `npx vitest run tests/unit/main-game-scene-mobile-ui.test.ts --project unit`:
  passed.
- `npx vitest run tests/headless/floor3-completion.test.ts --project headless`:
  passed, `outcome: 'victory'`, re-run post-merge.
- `npx vitest run tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts --project e2e`:
  passed (64.7s), re-run fresh post-merge (mandatory hard-gate requirement —
  not weakened in any way).
- Additional post-merge regression sweep on touched-adjacent files: main-game-scene
  corner-button-icons, simulation-pause, and hud-vitals-stack-corner-buttons
  suites confirmed clean (the latter has zero diff vs. `origin/main` — untouched
  by this branch, purely inherited from the merge).
- `npm run verify:fast`: passed.
- Lint, Prettier, and `npm run typecheck`: clean on all 6 changed files, both
  pre- and post-merge.

## Unresolved issues

- The #4206 recall mechanism is a deliberate best-effort design, not an
  airtight guarantee — see ADR 0104 "Known limitation" and "Risks" for the
  accepted pathological-cluster boundary case and why stronger interventions
  were rejected (each caused real companion deaths in the headless pipeline).
- #4204 is intentionally out of scope for this PR; it is closed separately
  citing merged PR #4183 as evidence.
- No unrelated Floor 3 balance tuning, enemy-AI redesign, or broader HUD
  redesign was made, per the explicit non-goals.
