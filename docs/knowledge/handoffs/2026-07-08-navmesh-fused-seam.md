# Session Handoff: NAVMESH_FUSED tangential-to-gradient SEAM term (Slice 4b)

## Date

2026-07-08

## Persona

Systems Engineer

## Systems touched

ai-pathfinding, ai-behavior-tree, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (exact) — an additive tangential-seam term on the
already-shipped 4a fused fan (small, byte-identical-at-weight-0 by construction),
BUT carrying the full 4–5🍎 harness (adversarial plan review + 2-round-clean code
review + 2-round-clean multi-model review) plus a real metric-semantics bug caught
and fixed mid-review. Full JSON in
`docs/knowledge/metrics/apples/2026-07-08-navmesh-fused-seam.json`.

## What Was Done

Added a **tangential-to-danger-gradient seam-following term** to the
`NAVMESH_FUSED` heading fan (Slice 4b, fork **A** — human-adjudicated). It rewards
**directional travel ALONG the danger boundary** (perpendicular to the danger
gradient) toward the goal _while farmable reward lies along that seam_ — so the
agent "travels the seams" instead of taking the shortest path or hiding in corners.
The shipping seam weight is **`w = 2`** (human-adjudicated from the candidate
sweep; see "Two-stage tuning" below).

This rides **additively on top of the 4a fan** and is entirely gated behind
`if (seamWeight > 0)`, so at the default weight the mode is **byte-identical to
shipped-4a by construction**, and `LEGACY` / pure-`NAVMESH` / grid
`RISK_REWARD_FUSED` are all untouched. The recast query stays **pure** — the seam
term is a **follow-time heading cost**, never a geometry rebuild (the load-bearing
Slice-3 lesson: recast reachability ⊊ grid at thin/door connectors).

### The seam term (`bt-ai-provider.ts` `computeRiskRewardFusedHeading`, ~3260-3415)

1. **In-loop capture (guarded):** under `if (seamWeight > 0)` the candidate loop
   stores `{dir, danger, score}` into pre-sized scratch `Float64Array`s. Weight-0 /
   non-NAVMESH_FUSED paths never enter the guard → main loop literally unchanged.
2. **Centered gradient (adversarial-review concern B2):**
   `grad = Σ dir_i·(danger_i − meanDanger)`. The raw `Σ dir_i·danger_i` would
   fabricate a forward-biased gradient under UNIFORM danger (the fan only spans
   ±90° forward), so the mean is subtracted → uniform danger ⇒ `grad ≈ 0` ⇒ seam
   inactive.
3. **Degeneracy guards (B3):** `gradLenSq > EPS` gate + finite checks; tangent sign
   flips only on strict `< 0` (no flip on exact 0) → deterministic.
4. **Reward-reachability gate (mandatory guardrail #2):** the seam bias applies
   ONLY when `rewardLen > eps` AND `rewardDir · tangent > 0` (farmable reward lies
   ALONG the boundary). Else `effectiveSeamWeight = 0` → pure 4a. This is what makes
   it "farm the seam," not "orbit an empty contour."
5. **Progress floor (anti-orbit guardrail #3):** no seam bonus for candidates below
   `SEAM_PROGRESS_FLOOR` → goal-progress always able to win.
6. **Term:** `seamAlign_i = max(0, dir_i · tangent)`; when the gate passes,
   `score_i += seamAlign_i · seamWeight`, then a second argmax re-selects the
   heading.

### Instrumentation (report-only; determinism-neutral)

`navmeshSeamPolls` / `navmeshSeamActivePolls` / `navmeshSeamAlignSum` public
counters → the sweep computes `meanSeamAlign = alignSum / activePolls`
(directional-travel proof) and `seamActiveFraction`. These NEVER feed `InputState`
(byte-identity safe) and are zeroed in `reset()`.

### Other edits

- `src/game/ai/bt-ai-tuning.ts` — `NAVMESH_FUSED_SEAM_WEIGHT = 2` (adjudication
  comment) + `DEFAULT_CONFIG.seamWeight`. Default `pathingMode` stays `LEGACY`.
- `src/game/ai/types.ts` — `AIConfig.seamWeight?: number`.
- `src/labs/ai-runner-lab/index.ts` — danger-gradient + tangent overlay vectors and
  a `seamWeight` GUI slider for visual seam-following inspection.
- `scripts/agent/perf/navmesh-seam-sweep.ts` (NEW) + `package.json`
  `ai:navmesh-seam-sweep` — report-only candidate-weight sweep harness (inertness
  tripwire only; computes the seam metrics above).

### Tests

- `tests/unit/ai/navmesh-pathing.test.ts` — seam activation + determinism +
  counter-equality + partial-path-guard cases (11/11 green at w=2), incl. a new
  `navmeshSeamAlignSum >= 0` assertion.
- `tests/headless/navmesh-fused-determinism.test.ts` — NAVMESH_FUSED same-seed
  byte-identity golden; **PASSED at w=2** (seeds 42/101, 2/2 byte-identical). It
  auto-tracks the shipped default. The pure-NAVMESH query golden `75917f12` is a
  DIFFERENT test, **UNCHANGED**.

## Observe before done (rule #10 — seam-following is the EXPLICIT feature)

- **Headless sweep JSON** (`files/seam-metric-postfix-w2.json`, the real headless
  runner, 3 seeds × 3 weapons at w=2): **meanSeamAlign 0.963** (strong directional
  alignment of the chosen heading with the seam tangent while active),
  **seamActiveFraction 3.4%**, **0 partial-path fallbacks**, **9 wins / 9
  completions ≥ pure-NAVMESH 8/9**, 0 regressions, 1 gain. The high meanSeamAlign +
  non-trivial active fraction is the quantitative proof the agent travels ALONG the
  boundary (not just avoids danger).
- **ai-runner lab — browser import-safety (the MANDATORY #913-class cover), VERIFIED
  this session** via Chrome/CDP at `?lab=ai-runner`: the full `src/game/ai` chain
  (incl. the new seam code in `bt-ai-provider.ts` + `navmesh-pather.ts`) imported and
  booted **clean** — the initial console had only a benign favicon 404, **zero
  import-time `ReferenceError`**. Setting pathing=`navmeshFused` + `seamWeight=2` in
  the GUI re-instantiated the AI provider **live with no throw** (`__aiRunnerDebug()`
  → `worldState:"playing"`, `pathing=navmeshFused`), exercising the seam block's
  module + construction path. Evidence: `files/slice4b-lab-navmeshfused-boot.png`.
  (A later `EquipmentUI.ts:410` `drawImage`-null error appeared **only after** I fired
  synthetic pointer events to try to wake the loop — a pre-existing engine-UI issue on
  a file 4b does not touch, unrelated to the seam/AI import path.)
- **Lab-viz caveat (honest):** an _animated_ capture of the agent tracing a contour
  could **not** be produced in the CDP automation browser — Phaser's update loop does
  not pump under headless CDP (`frame`/`polls` stayed 0 though my injected `rAF` ticked
  ~80fps and `scenePaused:false`), so the agent never moved and the overlay (which only
  draws while the sim advances) was not captured live. This is an environment quirk, not
  a code defect. The seam-following **behavior** proof is therefore the deterministic
  **headless sweep** metric above (`meanSeamAlign 0.963`, `seamActiveFraction 3.4%`) —
  the stronger, non-flaky Rule-#10 artifact. The overlay + `seamWeight` slider are wired
  in `src/labs/ai-runner-lab/index.ts` and can be watched interactively via `npm run lab`
  outside CDP.

## Key Decisions Made

- **Fork A (tangential-to-gradient + reward-reachability), weight w=2** — chosen by
  the human from the candidate sweep. Higher weights degrade: at w=3 partial-path
  fallbacks spike 8→18 and completions drop 31→30 (1 regression); at w=4 a win is
  also lost (2 regressions). w=2 sits **below the fallback-spike knee** — the seam
  bias helps without dragging the follower off-mesh into recast⊊grid pockets
  (guardrail #4).
- **Additive, weight-0-reproduces-4a** — the seam block is entirely behind
  `if (seamWeight > 0)`, so 4a is the A/B control and the hard gate cannot regress
  by construction at weight 0.
- **Eager scratch allocation kept (m3 deviation, disclosed):** the adversarial plan
  adopted concern m3 "no alloc at weight 0." Instance-level pre-sizing satisfies the
  core _no per-poll alloc_ intent, but the residual one-time construction alloc
  (~0.5 KB/AI, 5 `Float64Array`s) was **not** lazy-alloc-eliminated. Adjudicated
  immaterial (the sim fingerprint is state, not heap; lazy-alloc would add ~15
  hot-path non-null assertions for zero determinism benefit) and **explicitly
  accepted by the round-1 raiser (gpt-5.5) on re-review**. Documented transparently
  in the ledger; NOT a rule-#12 silent weakening.

## Honest disclosures (must survive to the PR)

1. **36-pair hard-gate evidence at w=2 is a 9-pair + bracket, not a full 36-pair
   w=2 run.** At finalize the only w=2 artifact was the 9-pair post-fix metric
   (9/9, 0 fallbacks, meanAlign 0.963); the 36-pair seam sweep on disk covers
   w=0/3/4 (`files/navmesh-seam-sweep-hi.json`), which brackets w=2 (w=0 → 30w/31c;
   w=3 → 30w/30c). **Shipped on this evidence per explicit human authorization**,
   because NAVMESH_FUSED is default-OFF and the live game is byte-identical
   regardless of the seam outcome. If a fuller number is ever wanted, re-run
   `npm run ai:navmesh-seam-sweep -- --seeds 1-12 --weapons sword,bow,baseball-bat --weights 2`.
2. **Metric-semantics tightening.** `meanSeamAlign` now counts ONLY polls where the
   heading was _actually re-selected_ by the seam term (was: any poll where the
   reward gate opened). Post-fix w=2 = 0.963 (was 0.972 under the looser semantics
   on a different seed set). The human's w=2 adjudication rested on
   completion/fallback/no-regression — all **unchanged** by the fix (the sim is
   byte-identical; only the diagnostic counter tightened) — so the decision stands.
3. **Per-weapon win shuffle at the aggregate level is noise (N=12).** Where a
   36-pair comparison exists, seam weights trade a sword win for a bow win (or vice
   versa) with net wins flat — expected at this sample size, not orbit-collapse.

## Determinism / guardrails

- SeededRandom only; **no** `Math.random` / `Date.now` in the seam path (asserted in
  the block comment and grep-verified).
- **No new module-load global/process/env read** — `seamWeight` comes from the
  constructor `AIConfig`, not env; the only `process.env` read in the file
  (`NAVGUARD_STATS`, ~305) is pre-existing, `typeof`-guarded, and read-once. #913
  guardrail satisfied trivially; browser-lab boot re-confirms import-safety.
- Rule #15 N/A — the seam term is a parameter on an existing fan, **no new exported
  `*System`** (nothing to wire/allowlist).
- New NAVMESH_FUSED determinism golden PASSED at w=2; pure-NAVMESH `75917f12`
  UNCHANGED.

## Review harness (4🍎 tier, ledger valid — exit 0)

`docs/knowledge/review-ledgers/2026-07-08-navmesh-fused-seam.review-ledger.json`:

- **plan_review** (gpt-5.5, **adversarial**, 6 alternatives, 11 concerns / 11
  resolved, `plan_divergence: minor`) — centered-gradient estimator + degeneracy
  guards + reward-gate + progress-floor + richer seam metric all adopted from the
  red-team.
- **code_review** — round 1: 3 distinct models (gpt-5.5, gemini-3.1-pro,
  claude-sonnet-4.6), 3 concerns, all resolved (counter-gating fix, reset fix,
  alloc doc-resolution); round 2: 2 distinct models (claude-sonnet-4.6, gpt-5.5),
  **CLEAN**. Loop closed at round 2, no escalation.
- **multi_model_review** (adjudicator claude-opus-4.8) — same rounds; all 3 round-1
  concerns judged valid + resolved; round 2 CLEAN.

## What's Next / Blockers

**Slice 4b ships as an opt-in, default-OFF improvement — it does NOT turn navmesh
on.** Three blockers remain before navmesh could become the LIVE default (none in
4b's scope):

1. **No head-to-head win-rate vs LEGACY at the sacred ≥90%.** 4a sits at ~86%
   (31/36). A live flip needs navmesh to match/beat LEGACY at ≥90% of Floor-1 seeds.
2. **Determinism fence is narrow.** The cross-platform GO is proven only for the
   flat / point-agent / solo navmesh config — eroded / multi-level / tiled builds,
   `findRandomPoint*`, and mac determinism are unre-validated.
3. **Door-lock cost layer not built.** Deferred from Slice 3 — locked door = a
   high query-time traversal COST (not a wall); its natural home is this seam-cost
   layer. Floor 1 has no locked-door-shortcut case today → later-floor watch.

These blockers ARE "the more slices" — the seam tuning (4b) is essentially done;
the remaining effort is the live-flip gate, not further pathing modes.

## Retrospective

### Lessons Learned

- **A green golden proves byte-identity, not metric correctness.** The seam counters
  were double-counting (incrementing on reward-gate-open, not on actual re-selection)
  yet every determinism gate stayed green — because the counters never feed the sim.
  The bug only surfaced in the _diagnostic_ that the Rule-#10 evidence rests on.
  Rule-#10 quantitative metrics need their own scrutiny separate from the golden.
- **`if (seamWeight > 0)` guarding is a clean way to make a new behavior term
  byte-identical-by-construction** to the prior slice — the A/B control falls out
  for free and the hard gate cannot regress at weight 0.
- **Centered gradient over a forward-only fan:** a raw `Σ dir·danger` sum fabricates
  a forward bias because the candidate directions only span ±90°. Subtracting the
  mean danger is the fix (adversarial reviewer's B2) — worth remembering for any
  future directional term computed over an asymmetric candidate set.

### Mistakes Made

- **Let the full-36-pair w=2 sweep artifact go missing before finalize.** The
  candidate sweep that the human adjudicated w=2 on was superseded on disk; only the
  9-pair post-fix metric + a w=0/3/4 36-pair bracket survived. Early signal: name
  and preserve the _exact_ artifact a human decision rests on (`git add` it or copy
  to a stable path) at decision time, not later. Shipped honestly on the surviving
  evidence with explicit human sign-off, but a future agent should snapshot the
  decisive sweep JSON immediately.
- **Initial seam counter semantics contradicted my own docstring.** The docstring
  said "re-selection"; the code incremented on gate-open. sonnet-4.6 caught it in
  round 1. Write the invariant-defining assertion (`alignSum >= 0`, counted only on
  re-selection) at the same time as the counter, not after review.

### Opportunities for Future Improvement

- **A tiny "seam metric" unit test** that drives a hand-built danger field and
  asserts `meanSeamAlign` counts only re-selections would have caught the
  double-count deterministically (cheaper than a model review round).
- **Persist decisive sweep JSONs under a stable, git-tracked path** (e.g.
  `docs/knowledge/metrics/sweeps/`) so a human decision always has a durable artifact
  rather than a `files/` scratch file that can be overwritten.
- The **door-lock cost layer** (blocker #3) is the natural next unit of work and now
  has a clean home in this follow-time cost layer.
