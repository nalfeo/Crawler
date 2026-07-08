# Session Handoff: AIPathingMode.NAVMESH_FUSED — danger/reward fan on navmesh follow (Slice 4a)

## Date

2026-07-08

## Persona

Systems Engineer

## Systems touched

ai-pathfinding, ai-behavior-tree, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (exact) — new pathing-mode enum value + poll()-seam rewire that composes two already-shipped/tuned layers (Slice-3 recast route + tuned RISK_REWARD_FUSED fan) with a load-bearing byte-identity no-op for the three pre-existing modes, plus the full >3🍎 review harness (plan review + dual-plan synthesis + 3-model code review + multi-model adjudication). Full JSON in `docs/knowledge/metrics/apples/2026-07-08-navmesh-fused-pathing.json`.

## What Was Done

Added `AIPathingMode.NAVMESH_FUSED` (`'navmeshFused'`) as a FOURTH selectable AI pathing mode (**default-OFF**), giving a clean 4-way A/B: `LEGACY` | pure-`NAVMESH` (Slice 3, untouched baseline) | `NAVMESH_FUSED` | grid `RISK_REWARD_FUSED`. NAVMESH_FUSED = **navmesh route FIRST, then the tuned danger/reward fan on that heading**: `moveTowardViaNavmesh` (the Slice-3 recast query, reused verbatim/pure) sets `state.moveX/moveY`, then `computeRiskRewardFusedHeading` (the already-tuned 13-candidate risk/reward argmax fan) deflects that heading. The recast query stays **pure** — danger/reward is a **follow-time cost on the heading**, NEVER a geometry rebuild (the load-bearing Slice-3 lesson: recast reachability ⊊ grid at thin/door connectors).

This is **Slice 4a = the PORT only**. It reuses the existing tuned FUSED weights **verbatim** and adds **NO seam term** — the danger-vs-reward-vs-seam WEIGHTING philosophy is the one genuine game-design fork, deferred to **Slice 4b behind a mandatory creator PING** (see "Seam-weighting fork" below). 4a introduces no new tuning.

### The poll() seam (byte-identity-sensitive hot path, `bt-ai-provider.ts` ~2600-2740)

Three explicit non-overlapping booleans replace the old single `useNavmesh`:

- `usesNavmeshRoute` = `NAVMESH || NAVMESH_FUSED` — drives the recast route dispatch.
- `usePureNavmesh` = `NAVMESH` only — **exactly equals the old `useNavmesh`**; the ONLY thing driving the two downstream skip gates (`&& !usePureNavmesh` on predictive travel steering + the Track B blend). So LEGACY / RISK_REWARD_FUSED / plain-NAVMESH evaluate every gate identically to before → **poll output byte-identical** (independently re-derived truth-table by all 3 reviewers).
- `useFused` = `RISK_REWARD_FUSED || NAVMESH_FUSED` — runs the fused fan. For RISK_REWARD_FUSED this is unchanged; for NAVMESH_FUSED it runs AFTER the navmesh route sets the base heading.

Only NAVMESH_FUSED adds new behavior; the other three are provably no-ops.

### Other edits

- `src/game/ai/types.ts` — `NAVMESH_FUSED: 'navmeshFused'` enum value + JSDoc.
- `src/game/ai/headless-runner.ts` — `initNavmesh()` gate broadened `=== NAVMESH` → `NAVMESH || NAVMESH_FUSED` (~466-472) so headless NAVMESH_FUSED runs don't throw at `ensureFloorNavmesh()`; disposal still unconditional. (This site was caught by the dual-plan synthesis — initial recon missed it.)
- `src/game/ai/headless-runner-cli-lib.ts` — `--pathing-mode` help text `navmesh` → `navmesh | navmeshFused`.
- `src/game/ai/navmesh/{index,navmesh-pather}.ts` — JSDoc `@link` mentions both NAVMESH + NAVMESH_FUSED.
- `src/labs/ai-runner-lab/index.ts` — `usesNavmeshRoute` / `usesFusedFan` helper predicates; 7 gate sites + the pathing dropdown updated so the lab renders BOTH the route overlay and the fused-fan overlay in NAVMESH_FUSED.
- `scripts/agent/perf/navmesh-sweep.ts` — extended to 3 modes (LEGACY / NAVMESH / NAVMESH_FUSED); `navmesh*` fields kept byte-stable, new `navmeshFused*` fields + aggregates + a **dual-mode inertness tripwire** (fail if EITHER navmesh mode completes 0 floors). Two review-fixes: the LEGACY↔NAVMESH regression flag moved back to the `N:` console column; the tripwire diagnostic names both modes when both are dead. (Console-only; JSON/gate untouched.)

### Tests

- `tests/unit/ai/navmesh-pathing.test.ts` — 3 new NAVMESH_FUSED cases: (a) functional both-layers poll (navmesh route + fused fan both engaged), (b) pure-NAVMESH preservation lock (NAVMESH poll unchanged with NAVMESH_FUSED present), (c) partial-path-guard fallback under NAVMESH_FUSED. `disposeNavmesh()` in a tracked-AI `afterEach` (exception-safe WASM-handle cleanup).
- `tests/unit/ai/headless-runner-cli-lib.test.ts` — `navmesh` + `navmeshFused` `--pathing-mode` parse assertions.
- `tests/headless/navmesh-fused-determinism.test.ts` — NEW; same-seed byte-identity for NAVMESH_FUSED (seeds 42/101, sword, `damageDealt>0` non-vacuity). Deliberately NOT a "differs from pure-NAVMESH" gate (plan-review concern #1: brittle; wiring proof lives in the deterministic unit test).
- `tests/determinism/navmesh-determinism.test.ts` — golden `75917f12` **UNCHANGED** (it hashes the recast QUERY layer only, which this AI-behavior change does not touch). Re-proves cross-platform in the Linux CI unit project at PR time.

## Observe before done (rule #10 — BOTH real artifacts named, not lab-only)

- **Headless sweep JSON** (`npm run ai:navmesh-sweep` → `files/navmesh-sweep-after.json`, the real headless runner): 36-pair 3-mode sweep (12 seeds × sword/bow/bat). **NAVMESH_FUSED 31 wins / 32 completions ≥ pure-NAVMESH 30 wins / 31 completions** — the HARD gate PASSES with a strict, no-regression improvement. Per-weapon F matches-or-beats N on all three weapons (sword N10c11→F11c12, bow N11→F11, bat N9→F9). NAVMESH_FUSED had **0 partial-path fallbacks** (fan never destabilized the follow) vs pure-NAVMESH's 8. In-run pure-NAVMESH (30w/31c) **exactly matches** the frozen pre-change baseline → corroborates the rename no-op at the sweep level.
- **ai-runner lab viz** (`npm run lab` → `/lab.html?lab=ai-runner`, pathing=navmeshFused): the agent **cleared Floor 1** ("Floor 1 complete!") — Lv 6, 182/190 HP (near-flawless = danger-avoidance), 82 gold + 25 kills (reward-farming), boss beaten, full quest clear. The purple **navmesh route overlay renders**, and the full `ai-runner → bt-ai-provider → navmesh` import chain ran with **zero console errors** (only a benign 16×-speed accumulator-clamp warning) → import-safe (the #913 near-miss interim cover per the mandatory guardrail).

## Determinism / guardrails

- SeededRandom only; no `Math.random` / `Date.now` in the new path.
- New determinism golden = the NAVMESH_FUSED headless byte-identity test; pure-NAVMESH golden `75917f12` kept UNCHANGED.
- Rule #15 N/A — enum value + poll branch, **no new exported `*System`** (nothing to wire/allowlist).
- Module-load global/process/env reads: none added (the only navmesh `process` ref, `navmesh-pather.ts` `process.versions`, is pre-existing, `typeof`-guarded AND inside call-time `isNodeRuntime()`).

## Review harness (full >3🍎 tier, ledger valid)

`docs/knowledge/review-ledgers/2026-07-08-navmesh-fused-pathing.review-ledger.json` — all 4 stages complete + `validate` exit 0:

- **plan_review** (gpt-5.5) — 3 concerns, all resolved (brittle non-inertness assertion → same-seed-only headless + deterministic unit wiring proof; report-only sweep vs SHIP-criterion gate reconciled; 3-boolean clarity adopted).
- **dual_plan_synthesis** (gpt-5.4 + gemini-3.1-pro plans, opus-4.8 judge) — caught the `headless-runner.ts` init-gate site; adopted the separate-file determinism test.
- **code_review** — 3 distinct models (claude-sonnet-4.6, gpt-5.3-codex, gemini-3.1-pro-preview). codex + gemini NO CONCERNS; sonnet verified byte-identity + 2 console-only sweep issues, both fixed.
- **multi_model_review** (adjudicator claude-opus-4.8) — the 2 sonnet findings judged valid + fixed; no cross-model disagreement on the byte-identity invariant. Clean round 1.

## Seam-weighting fork (DEFERRED to Slice 4b — mandatory creator PING)

Slice 4a intentionally stops at the PORT. The SEAM-preference philosophy — reward routes ALONG the danger gradient/boundary (≠ pure danger-avoidance which hides in corners, ≠ shortest-path) — is the one genuine game-design fork and must be adjudicated by the human with sweep data + lab viz BEFORE any 4b tuning (creator's repeated, explicit instruction; rules #12/#13 — do NOT silently tune to a number). PING sent to the creator/coordinator session at ship time.

## Deferred (fold into 4b / later-floor watch)

- **Door-lock as a query-time traversal COST** (locked door = high cost, not a wall) — the follow-time cost layer is its natural home; belongs with the 4b seam-cost work.
- **Locked-door-SHORTCUT risk** — a later floor could route the static all-doors mesh toward a locked door; the cost layer must penalize locked-door traversal enough to avoid it. Floor 1 has no such case today → later-floor watch.

## Next Steps

1. Ship 4a: PR + arm `gh pr merge --auto --squash` (green + default-OFF + harness-clean + ledger-valid + byte-identical).
2. Creator PING at the seam-weighting fork (4b) with the sweep table + lab-cleared viz + weighting options.
3. On 4b GO: add the seam term at follow level (danger-gradient boundary reward), re-sweep, extend the lab viz; new determinism golden for any behavior change; keep 75917f12 + #914 byte-identity tests green.
4. Non-blocking follow-up C (separate PR): cheapest CI-gated browser-import-safety check for `src/game/ai` (creator leans a deterministic static scanner for unguarded module-scope Node globals, ~1🍎).
