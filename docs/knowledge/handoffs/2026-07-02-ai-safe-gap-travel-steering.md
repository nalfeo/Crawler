# Session Handoff: AI Runner predictive safe-gap travel steering

## Date

2026-07-02

## Persona(s) adopted

**Producer** (routing/ownership for a multi-layer AI change) → drove a **Systems/AI**
specialist workstream. The task spans `src/game/ai/` logic, tuning, a new pure
module, headless measurement tooling, and the full review harness, so Producer
ownership with AI-systems execution was the right fit.

## Routing verdict

✅ right persona — the change is squarely AI-runner pathing; Producer framing kept
the win-rate gate and the "damage-agnostic / no-engine-tweak" constraints front
and center across many iterations.

## Apples

Estimated: 🍎 x 4 <!-- declared at session start -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — a new pure steering subsystem (`travel-steering.ts`, ~600 lines)
plus provider wiring, tuning, a measurement lens, and a 4-apple review harness is a
textbook Large change. It was iteration-heavy (many sweep/bisect cycles, several
envelope regressions reverted) but the shipped scope is a clean 4, not a 5.

Hello kitties: 4/5 = 0.80 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-ai-safe-gap-travel-steering.review-ledger.json`
Stages (4🍎): plan_review ✅ · dual_plan_synthesis ✅ · code_review ✅ · multi_model_review ✅
`npm run review:ledger -- validate <path>` → **pass (exit 0)**.

- **code_review** looped to clean over 2 rounds: round 1 (gpt-5.5 + gemini-3.1-pro +
  claude-sonnet-4.6) surfaced 5 concerns; round 2 (gpt-5.5) on the final shipping
  diff → "No concerns — clean".
- **multi_model_review**: 3 distinct reviewer models, adjudicated by claude-opus-4.8.
  2 concerns shipped behavior-neutral (S2 CCD epsilon, Gem2 dead-code); 3 concerns
  (spawner threat inclusion, per-body contact radius, loot-pull gate) implemented
  then **deferred** because bundled they regressed the win-rate envelope (see below).

## What Was Done

Reworked the AI Runner so it **predictively arcs/kites around mobs while travelling**
to objectives (not only during ENGAGE), reusing the proven ENGAGE kite-tangent math,
cutting contact damage and blending in loot/XP farming while still completing Floor 1.

- **New pure module `src/game/ai/travel-steering.ts`** (no ECS/Phaser deps):
  candidate-fan scoring (`scoreTravelCandidate`), a continuous-collision
  predicted-min-gap (`predictedMinGapFt`), `pickSafeTravelHeading`, and a shared
  `extractKiteTangent`. Deterministic, unit- and property-tested.
- **Provider wiring** (`bt-ai-provider.ts`): `computeTravelSteering` builds perceived
  threats and drives the travel heading; poll() blends the steered arc with the
  objective heading and retires the additive dodge when steering owns the frame.
- **Tuning** (`bt-ai-tuning.ts`): surface-gap envelope (HARD/SAFE/COMFORT) anchored to
  the ENGAGE orbit, body radius, CCD epsilon.
- **Measurement lens** (`damageSystem.ts`, `world.ts`, `winrate-sweep.ts`,
  `headless-runner*.ts`): optional `hostileDamageMultiplier ?? 1` (default 1 → **zero**
  behavior change) so "just run through enemies" can be _measured_ as costly. The AI
  never reads it — proven by `tests/game/ai-damage-invariance.test.ts`.
- **Review fixes shipped** (behavior-neutral, `214f553b`): CCD degenerate-parallel
  epsilon `1e-4 → 1e-8`; removed dead `if (dist < EPSILON)` branch in
  `extractKiteTangent`; +2 pure-module tests.

### Runtime observation (before/after, deterministic)

- Canonical headless gate `tests/headless/floor1-completion.test.ts`: **9/9 GREEN**.
- Full 1x sweep (seeds 1-16 × sword/bow/baseball-bat, dmg ×1): **83.3% (40/48)** vs
  main **81.25%** (+1 win). Quality vs main: **−~20% total damage taken, min-HP
  ~61% → ~76%, gold +~11%**, natural lateral arcs instead of straight-line charges.
- The shipped review-fix commit is **byte-identical** on the sweep to the pre-fix
  envelope (same 40/48, same 8 fails, same outcomes) — confirming neutrality.

## What's Next

1. **Open the PR** (ledger passes; handoff written). Holistic title covering: pure
   travel-steering module + conservative gap envelope + ENGAGE-kite reuse +
   damage-agnostic measurement lens + the 2 shipped review fixes.
2. **Nav-layer follow-up (deferred concerns + the 2/12/13 loss cluster)** — one issue:
   - Root-cause the pre-existing **safe-room / nav-wedge** losses on seeds **2, 12, 13**
     (all 8 losses are timeouts/one death _while alive_ — EXPLORE-dominant wedges, not
     kiting failures). These are the gap between 83.3% and the 90% target.
   - Re-land the 3 deferred review enhancements **without** flipping winning seeds:
     **G1** include static spawners in the travel threat query; **Gem1** per-body
     contact radius for 3×3 spawners; **S1** gate the loot/farm pull under low predicted
     gap. Bundled they flipped seeds 6-bow/15-bow/8-bat into nav-wedges (83.3%→77.1%);
     they likely need the wedge-escape work first (adding static blockers + widening
     avoidance is what tips symmetric standoffs into hard wedges).

## Blockers

None for shipping the current scope. The 90% win-rate target is **not** met (83.3%);
the shortfall is a **pre-existing nav-wedge cluster on seeds 2/12/13**, not a kiting
regression — deferred to the nav-layer follow-up above. Do not cherry-pick seeds to
force the gate (rule #13).

## Branch State

- Branch: `nalfeo-tune-ai-dodge-pathing`
- All tests passing: yes (`verify:fast` 100 unit tests; headless gate 9/9; full
  `verify` run as part of PR prep)
- PR created: pending (next step)

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` does not exist this session.

## Test Results

- `npm run verify:fast` → ✅ 100 unit tests, typecheck + lint clean.
- `tests/headless/floor1-completion.test.ts` → ✅ 9/9 (451s).
- 1x sweep → 40/48 (83.3%), losses only on seeds 2/12/13.

## Key Decisions Made

- **Gate on win-RATE aggregate, never cherry-pick** (rule #13). When the 5-fix bundle
  regressed the envelope to 77.1% by flipping 3 winning seeds, reverted the 3
  behavior-changing enhancements rather than ship a regression or hand-pick seeds.
- **Deferral ≠ weakening a review stage** (rule #12). The 3 deferred concerns are
  main-parity _enhancements_ (main is equally blind to spawners / equally blends the
  loot pull), not defects this branch introduced; deferring with root cause + a tracked
  follow-up is a legitimate adjudication outcome, recorded honestly in the ledger.
- **Damage-agnostic AI**: the enemy-damage multiplier is a measurement lens only
  (default 1); the AI never branches on it (invariance test enforces this).

## Retrospective

### Lessons Learned

- **A pure module pays off**: putting the steering math in `travel-steering.ts` with no
  ECS/Phaser deps made it unit- and property-testable and let review concerns be pinned
  with fast deterministic tests instead of full sweeps.
- **Sweeps are the source of truth, and they're expensive**: a full 48-run 1x sweep is
  ~12–18 min and buffers all output until done (`Select-Object -Last N` won't stream).
  Launch it async, do other prep, wait for the completion notification.
- **Adding static blockers can _create_ wedges**: including spawners as threats + widening
  avoidance radius tipped symmetric corridor standoffs into hard multi-minute wedges on
  a few seeds — the opposite of the intended safety gain. Avoidance enhancements need
  wedge-escape logic first.
- **Byte-diff the sweep JSON** (`totalWins` + `winRate` + `fails` set) to _prove_ a
  change is behavior-neutral, rather than eyeballing the summary table.

### Mistakes Made

- Initially shipped all 5 review fixes together and only then ran the validating sweep;
  the bundle regressed the envelope (83.3%→77.1%). Early signal I should have heeded:
  three of the five were _enhancements to main-parity behavior_, not fixes for
  branch-introduced defects — those are exactly the ones that risk moving the win-rate
  gate and should be validated in isolation (or behind the nav-wedge work) before
  bundling.

### Opportunities for Future Improvement

- A **fast per-seed regression harness** (run only the 13 known-winning seeds, ~5 min)
  as a pre-commit smoke before the full 48-run sweep would catch flips much sooner.
- Promote the **nav-wedge class** into a deterministic headless assertion (seeds 2/12/13)
  so the follow-up has a red test to drive against, per rule #10.
