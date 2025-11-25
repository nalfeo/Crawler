# Session Handoff: Spawner red placeholders + wire spawner effects into the real game

## Date

2026-07-02

## Persona(s) adopted

Producer (lead) + Engine/Rendering + Game Systems + QA. Producer fit because the
work crossed `shared` → `engine` → `game` → `tests`, required a 4-apple review
harness, and ends in PR + auto-merge + a follow-up investigation session.

## Routing verdict

✅ right persona — cross-layer gameplay + rendering wiring fix with a full review
harness, runtime validation, and PR/coordination artifacts.

## Apples

Estimated: 🍎 x 4
Actual: 🍎 x 4
Verdict: 🎯 Exact — the root-cause fix was tiny (one missing `spawnerSystem` call
per pipeline), but the change spanned four layers and the 4-apple harness earned
its keep: the code-review loop caught a visual-pipeline ordering bug and
multi-model review caught a cross-pipeline director-position divergence plus an
over-claimed "adjacency" comment.

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

enemies

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-spawner-red-placeholders-and-effects.review-ledger.json`
Stages (4-apple tier — all required): `plan_review` ✅ · `dual_plan_synthesis` ✅ · `code_review` ✅ · `multi_model_review` ✅
`npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-02-spawner-red-placeholders-and-effects.review-ledger.json` → **pass (exit 0)**

Harness highlights:

- **plan_review** (gpt-5.4): 5 concerns raised / 5 resolved.
- **dual_plan_synthesis**: plans from gpt-5.5 + claude-opus-4.7, judged/synthesized by claude-opus-4.8.
- **code_review** loop (2 rounds → clean): round 1 caught that `spawnerSystem` ran
  **after** the director in the visual pipeline but **before** it in headless →
  reordered the visual `preSystems` so spawner precedes director, and added an
  ordering-contract test.
- **multi_model_review** (adjudicator claude-opus-4.8, 3 rounds):
  - R1: mmr-codex clean; mmr-gemini raised a HIGH pipeline-parity concern
    (director runs pre-core in visual vs post-core in headless).
  - Adjudication = **DOCUMENT-AND-TRACK**: the divergence is real but bounded to
    one-frame (~16ms) effects; do **not** move pipeline order in this PR (out of
    scope). Filed tracking issue **#663**; rewrote over-claiming comments to
    honest approximation language.
  - R2: both models flagged a NEW false claim in my honesty comments (I'd written
    spawner→director _adjacency_ holds in **both** pipelines — false; headless has
    the core pipeline between them). Corrected all 4 comments to the TRUE
    invariant.
  - R3 (confirmation): confirm-codex + confirm-gemini both **CLEAN**.

## What Was Done

**1. Made placeholder spawners obviously placeholders (bright red).**

- `src/engine/phaser-bridge/sprite-kind.ts`: added `PLACEHOLDER_SPAWNER_TINT = 0xff3030`
  and a pure `placeholderSpawnerTint()` helper; SpawnAnim pop-in render.
- `src/engine/PhaserBridge.ts`: per-frame red tint applied to placeholder spawner
  sprites, gated on `entityType === 'enemy' && !corpseDecay`.

**2. Fixed the real bug: the spawner effects were never turned on.**

- Root cause: `spawnerSystem` (emits child enemies + `spawnerPulse` VFX +
  `SpawnAnim` pop-in) was built and lab-proven in a prior session but **never
  called** in either real pipeline — only inside `spawner-lab`. The VFX chain was
  fully live; only the _call site_ was missing.
- Wired `spawnerSystem` into **both** real pipelines:
  - Visual: `src/bootstrap/floor-main-scene-options.ts` `preSystems`
    (`…enemyAISystem, spawnerSystem, floor1EnemyDirectorSystem`).
  - Headless: `src/game/ai/simulation-step.ts` (pre-movement), which is the
    pipeline the win-rate gate + `headless-runner` actually execute.

**3. Tuned spawner balance conservatively.**

- `src/game/spawners/registry.ts`: reduced archetype trickle rates / alive caps so
  newly-live spawners don't spike Floor 1 difficulty.

**4. Documented + tracked the visual↔headless pipeline divergence (#663).**

- The two hand-maintained pipelines are NOT byte-identical: the director runs
  pre-core in visual but post-core in headless; the weapon system runs
  pre-movement in visual but post-movement in headless. Consequence: spawner and
  director are **adjacent** only in the visual pipeline; in headless the core
  pipeline sits between them.
- The one **shared, true** invariant (safe to claim, asserted by tests): in both
  pipelines `spawnerSystem` runs **before** `floor1EnemyDirectorSystem` in the
  same frame, so the director's population cap counts this frame's freshly-spawned
  children. Comments in
  `floor-main-scene-options.ts`, `src/engine/sim/simulation-step.ts`, and
  `src/game/ai/simulation-step.ts` now say exactly this and reference #663 —
  no "byte-identical / mirrors / provably-conservative" over-claims.

**5. Tests.**

- `tests/unit/phaser-bridge-sprite-kind.test.ts` + `tests/unit/phaser-bridge.test.ts`:
  render-path assertions that placeholder spawners get `setTint(0xff3030)`.
- `tests/integration/floor1-spawners-pipeline.test.ts`: drives the **real** Floor 1
  visual + headless pipelines and asserts children actually spawn (3 tests).
- `tests/game/floor1-main-scene-options.test.ts`: ordering-contract test
  (`directorIndex === spawnerIndex + 1` in visual; single-occurrence asserts).

**6. Filed issues.** `#652` (AI-runner EXPLORE-timeout bug — the dominant Floor 1
failure cause) and `#663` (visual/headless pipeline unification tracking).

## Runtime validation (observe-before-done — the whole point of this session)

This session exists because a prior spawner feature was "validated by actually
seeing" — but only in `spawner-lab`, which **force-calls** `spawnerSystem`. The
lab passed while the real game never ran the system. Lesson applied here by
splitting validation by concern and using the **correct artifact** for each:

- **Wiring (does the real game run spawnerSystem?)** — validated in the **REAL
  pipelines**, deterministically, **not** the lab:
  - `tests/integration/floor1-spawners-pipeline.test.ts` drives
    `createFloor1MainSceneOptions` (visual) + headless `runSimulationStep` and
    asserts children spawn. ✅
  - Headless Floor-1 win-rate gate (`tests/headless/floor1-completion.test.ts`)
    17/17 with spawners now active. ✅
- **Red tint (pure render-path change)** — observed **live** in the running Phaser
  artifact. `lab.html?lab=spawner-lab` renders spawner sprites through the _same_
  `PhaserBridge` render code as the game; the tint has no wiring dependency, so
  the lab is a valid place to _see_ it. Screenshot:
  `files/spawner-red-tint-observed.png` — both placeholder spawners render bright
  red, HUD shows `Rats Nest … alive 3` / `Slime Pool … alive 3` (actively
  emitting children). ✅
- **Win-rate (Rule #13, gate on win-RATE not seeds).** 60-run holdout sweep (seeds
  1–20): **75% (45/60), identical to the spawners-inert baseline** — the change is
  win-rate-neutral (no regression, no overfit; held-out seeds 9–20 marginally
  better than baseline). The 90% target is **not** met, but that is **pre-existing**
  (baseline is also 75%); 14/15 failures are `EXPLORE`-dominated AI-runner
  timeouts (#652), **not** spawner deaths. No seeds were cherry-picked and no
  balance was bent to rescue specific runs. Evidence:
  `files/winrate-baseline.json`, `files/winrate-holdout-final.json`.

## What's Next

- **Spawn the follow-up investigation session** (user's explicit request): why did
  a whole feature ship "validated by seeing" yet never get turned on? Smoking gun:
  `docs/knowledge/handoffs/2026-06-30-spawner-spawn-vfx.md` lines 120 & 139 — it
  validated a _wiring-dependent_ feature **only** in `spawner-lab` and explicitly
  concluded the lab "is enough to validate this feature end-to-end." Deliverable:
  a process fix so "observe before done" requires the **real** artifact (game /
  headless), not a lab that force-calls the system under test.
- Land #663 (pipeline unification) so visual + headless stop diverging.
- Land #652 (AI-runner EXPLORE timeout) to move Floor 1 win-rate toward the 90%
  target — this is the real lever, not spawner balance.

## Blockers

- None. All review-harness stages complete; ledger validates (exit 0).

## Branch State

- Branch: `nalfeo-fluffy-guide`
- HEAD before this handoff: `cf111867` (core fix). Ordering-fix comments/tests +
  ledger + this handoff + apple metrics are being committed next.
- All touched tests passing: yes (typecheck + lint + touched unit/integration green)
- PR created: pending (next step after `npm run verify`)

## Agent-OS Telemetry

Guard telemetry artifact `files/guard-telemetry.jsonl` is **absent** for this
session — section intentionally skipped.

## Test Results

- `npm run verify:fast` ✅ (typecheck + lint + changed unit tests)
- `npm run review:ledger -- validate …2026-07-02-spawner-red-placeholders-and-effects.review-ledger.json` ✅
- Integration (real pipelines) `tests/integration/floor1-spawners-pipeline.test.ts` ✅
- Ordering contract `tests/game/floor1-main-scene-options.test.ts` ✅
- Render-path tint `tests/unit/phaser-bridge*.test.ts` ✅
- Headless win-rate gate 17/17 ✅; 60-run holdout sweep 75% (= baseline) ✅
- Live render observation: `files/spawner-red-tint-observed.png` ✅
- `npm run verify` (full) — run at PR-prep (recorded in checkpoint/PR).

## Key Decisions Made

- **Validate wiring in the real pipeline, not the lab.** The lab force-calls the
  system, so it can only prove the system works in isolation — never that the game
  calls it. This is the exact failure mode this session investigates.
- **Document-and-track the pipeline divergence (#663) rather than move pipeline
  order.** Reordering headless to match visual is a broader, riskier change; the
  divergence is bounded to one-frame effects, so it's tracked, not rushed.
- **Claim only the true invariant** (spawner-before-director in both; adjacent only
  in visual). Removed all "byte-identical / provably-conservative" over-claims.
- **Tune spawners down, don't bend balance to seeds.** Win-rate stayed at baseline
  75%; the 90% gap is owned by AI-runner bug #652.

## Retrospective

### Lessons Learned

- A green lab is **not** evidence a feature is wired into the game when the lab
  itself calls the system under test. "Observe before done" must name the artifact
  and it must be the **real** one (game or headless pipeline) for anything
  wiring/behavior-dependent.
- Two hand-maintained sim pipelines are a standing trap: the same feature can be
  correctly ordered in one and subtly mis-ordered in the other. The review harness
  (esp. multi-model) is what surfaced both the ordering bug and my own
  over-claiming comment — worth the cost at 4 apples.

### Mistakes Made

- My first honesty-comment rewrite over-corrected into a _new_ false claim
  (asserting spawner→director adjacency in both pipelines). Two independent models
  caught it; fixed to the genuinely-shared invariant. Precision in "honest"
  comments matters as much as in code.

### Opportunities for Future Improvement

- Make "observe before done" enforce artifact provenance: for wiring/behavior
  changes, require a **real-pipeline** deterministic check (integration/headless),
  and treat lab-only validation as insufficient. (Feed this into the follow-up
  investigation session's process fix.)
- Unify the visual + headless pipelines (#663) so ordering contracts don't have to
  be maintained in two places.
