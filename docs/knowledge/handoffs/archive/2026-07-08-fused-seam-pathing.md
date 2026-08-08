# Session Handoff: RISK_REWARD_FUSED danger/reward pathing (opt-in, default-OFF)

## Date

2026-07-08

## Persona

Producer (single-branch slice: port + retune + viz + review, held for human sign-off)

## Systems touched

ai-pathfinding, ai-combat-balance, ai-behavior-tree

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact). Single-system feature (a second AI pathing
mode behind the existing A/B seam) + retune + viz + 3🍎 review harness. Held at 3
by the hard no-default-change / byte-identical-main fence.

## What Was Done

Implemented the real **`RISK_REWARD_FUSED`** pathing mode — the previously-inert
enum stub from the two-axis AI A/B toggle (PR #851) is now a working
danger/reward-field heading scorer, selectable via `AIPathingMode` and the
ai-runner lab. **Both mode axes still default `LEGACY`; main is byte-identical.**

- **Scorer (`computeRiskRewardFusedHeading`, `src/game/ai/bt-ai-provider.ts`).**
  Fans 13 candidate offsets `[0, ±15, ±30, ±45, ±60, ±75, ±90]°` around the
  objective heading and argmaxes `score = progress·W_PROGRESS(1.0) +
reward·rewardLen·W_REWARD(0.95) − danger·W_DANGER(1.0) +
continuity·W_CONTINUITY(0.18)`. Danger = Σ over perceived live enemies
  (velocity-projected `VELOCITY_LOOKAHEAD_FRAMES=14`) within `DANGER_RADIUS_FT=9`
  of `(1−dist/radius)²`, ×`WALL_AMPLIFICATION(2.4)` when wall-adjacent. Strict-`>`
  argmax (first-in-order tie-break) = deterministic. Only runs when
  `pathingMode === RISK_REWARD_FUSED`.
- **Retune v1** (vs the entangled #811 weights, which failed the A/B gate with 7
  flips): `DANGER_RADIUS_FT 15→9`, `W_DANGER 1.8→1.0`, `FOG_DANGER 0.35→0.0`,
  `DOOR_DANGER 0.6→0.0`. Fog/door danger zeroed because they deflected travel
  without a live-threat justification.
- **Visualization / debuggability** (required by the maintainer): candidate-fan
  overlay (each rotated candidate + its score), danger/reward field heatmap, a
  Modes HUD showing the active pathing/decision mode, and an opt-in
  `FusedHeadingDebug` capture (`getFusedDebug()`), all in the ai-runner lab.
- **A/B harness** (`scripts/agent/perf/ab-pathing-mode.ts`, `npm run
ai:ab-pathing-mode`): runs each seed×weapon under LEGACY then FUSED and gates
  on **0 win→loss flips**, exiting non-zero on any flip. **Manual-only** — not in
  any CI workflow or `scripts/agent` gate.

### Accepted known limitation (the important finding)

The A/B sweep on the **new welcome-room Floor-1** (post-#853) is a **melee-favoring
WASH**: LEGACY 32/36 == FUSED 32/36, with **2 win→loss flips** (bow-707 timeout,
bat-404 boundary slow-win) and 2 recoveries. Per-weapon the story is real, not
noise: **sword clearly better + faster under FUSED** (danger deflection helps an
aggressive melee close), **bow hurt** (danger deflection disrupts ranged kiting).
A single global weight-set can't win for both playstyles.

**Decision (human):** ship FUSED **opt-in / default-OFF** as documented
experimental; **retain** the A/B win-rate gate as a truthful guard (it _correctly_
FAILs on the new Floor-1 — that FAIL is the guard doing its job, do **not** weaken
it, rules #12/#13); and make **navmesh the real pathing path** (Slice 3, spike =
GO — see below). Nothing about this touches main's shipped LEGACY default.

### Code-review-driven fixes (commit `7317b828`)

Round 1 (claude-sonnet-4.6) verified all four hard contracts and found 2
NON-BLOCKING issues; both fixed:

- **#2 — root cause of the bow regression.** FUSED mode skipped the additive
  Track B blend entirely, so when the scorer yields `{0,0}` (no travel target —
  e.g. a ranged AI between shots) the player **froze** for the frame instead of
  sidestepping the way LEGACY does. Fixed by passing dodge/pull through when the
  scorer yields `{0,0}`, gated on a `fusedYieldedZero` flag that **can only be
  true in fused mode**, so LEGACY stays byte-identical.
- **#1 — continuity consistency.** The `blendedLen<=eps` early return now clears
  `prevFusedDir` like the `baseLen<=eps` return, so a non-consecutive fan poll
  cannot bias the next heading via the continuity term.

Round 2 (claude-sonnet-4.6) re-verified all four contracts with file:line
evidence — **loop closed, clean, no concerns**.

### Review harness (3🍎, tier-3 ledger)

- Plan review (gpt-5.4): 3 concerns, all resolved (1 BLOCKING = fused determinism
  unproven → closed with a determinism headless test; + continuity clear +
  softened brittle assertion).
- Code-review **loop, 2 rounds** (claude-sonnet-4.6): R1 2 non-blocking → both
  fixed (`7317b828`); R2 clean.
- Ledger: `docs/knowledge/review-ledgers/2026-07-08-fused-seam-pathing.review-ledger.json`
  (validates as a 3-apple ledger).

## Observe Before Done (deterministic, real pipeline)

Validated in the **real headless sim pipeline** (not just a lab — the lab
force-calls the scorer and can't prove wiring):

- `tests/headless/collision-pair-parity.test.ts` (5/5) — the **byte-identity
  proof**: default LEGACY `BehaviorTreeAI` matches #853's baked golden
  fingerprints on the _new_ code ⇒ main's shipped default path is byte-for-byte
  unchanged.
- `tests/headless/fused-pathing-determinism.test.ts` (3/3) — FUSED is
  byte-identical across two runs (seeds 42/101) **and** diverges from LEGACY
  (non-inert; proves the mode is actually wired and active).
- `npm run ai:ab-pathing-mode` — the real-artifact A/B win-rate sweep that
  surfaced the melee-favoring wash (files/ab-pathing-newfloor1.{log,json}).
- `npm run verify:fast` (93 unit incl. `tests/unit/ai/fused-pathing.test.ts`).

## Navmesh spike (Slice 1) — GO, queued as Slice 3

Child session `nalfeo-navmesh-determinism-spike` verified recast-navigation
`computePath` is **byte-for-byte deterministic cross-platform** (win/arm64 ↔
linux/x64, Node 24 ↔ 22; hash `741fefa4`, 6779B payload). **#1 FOOTGUN: must
force the REAL `.wasm` build** (package default under Node is asm.js compat = a
different float path). Load-bearing pinned config in
`docs/knowledge/handoffs/2026-07-07-navmesh-determinism-spike.md`: `setRandomSeed(0)`,
`minRegionArea 8` (NOT 1), `+Y` winding `[0,2,1,0,3,2]`, `walkableRadius 0`, solo
navmesh, halfExtents `{4,8,4}`. On an unmerged branch with a **TEMP Linux CI
workflow that must NOT reach main**; recast is a devDependency. Navmesh is the
real pathing rework — queued as **Slice 3** = a deterministic path-query layer
behind the same A/B pathing-mode seam.

## Key Files

- `src/game/ai/bt-ai-provider.ts` — `computeRiskRewardFusedHeading` (scorer),
  the `useFused`/`fusedYieldedZero` blend seam (~2569–2645), retune consts,
  `RISK_REWARD_FIELD_CONSTANTS`, `FusedCandidateDebug`/`FusedHeadingDebug`,
  `getFusedDebug()`, `prevFusedDir` lifecycle.
- `src/game/ai/bt-ai-tuning.ts`, `src/game/ai/types.ts`, `src/game/ai/index.ts` —
  `AIPathingMode`, defaults (both LEGACY), barrel exports.
- `src/labs/ai-runner-lab/index.ts` — candidate-fan + field-heatmap overlays,
  Modes HUD.
- `scripts/agent/perf/ab-pathing-mode.ts` — manual A/B win-rate sweep + gate.
- `tests/headless/fused-pathing-determinism.test.ts`,
  `tests/unit/ai/fused-pathing.test.ts`.
- `docs/knowledge/review-ledgers/2026-07-08-fused-seam-pathing.review-ledger.json`,
  `docs/knowledge/metrics/apples/2026-07-08-fused-seam-pathing.json`.

## Gotchas / Follow-ups

- **FUSED is opt-in / default-OFF and byte-identical to LEGACY on the default
  path.** `fusedYieldedZero` and every fused code path are dead unless
  `pathingMode === RISK_REWARD_FUSED`. Do not flip the default without a fresh
  win-rate sweep + human sign-off.
- **The A/B gate FAILing on Floor-1 is expected and correct** — FUSED is a
  melee-favoring wash. The gate is a truthful guard against promoting FUSED to
  default. **Never weaken it or cherry-pick seeds** to make it green (rules
  #12/#13); fix the _mode_ (or ship navmesh) instead.
- **Retune v1 sensitivity is not swept.** The weights were tuned to pass the OLD
  Floor-1 (which they did, +4) but only WASH the new welcome-room Floor-1. A weight
  sweep across seeds/weapons was deliberately NOT done (the maintainer chose to
  pivot to navmesh rather than keep hand-tuning a global weight-set).
- **The A/B gate can miss slow/jittery wins** — `isWin` requires
  `outcome==='victory' && gameTimeMs < FLOOR1_TIME_BUDGET_MS (360000ms)`, so a
  boundary slow-win (e.g. bat-404 at 371s) counts as a flip. Intentional (favors
  decisive wins) but worth knowing when reading flip counts.
- **Continuity is a lifecycle field.** `prevFusedDirX/Y` must be cleared on every
  non-consecutive poll (both early returns now do; `reset()` does). A future edit
  adding a third early return must clear it too.
- **Determinism is shared with the whole engine.** FUSED introduces no new RNG /
  clock; its determinism rides on bitecs stable query order + IEEE-754 float
  math, same as the rest of the sim.

## Status

Branch `nalfeo-fused-seam-pathing`, HEAD `7317b828`, ahead=3 behind=0, clean.
**Nothing pushed/PR'd** — draft PR opens next, then HOLD for explicit human merge
go ("shepherd it in"). PR #811 untouched.
