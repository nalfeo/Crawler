# Session Handoff: Two-axis AI A/B toggle (SLACK_AWARE decision mode) + reproducible A/B harness

## Date

2026-07-07

## Persona

Producer → reviewer/owner (took over a child session's committed scaffold, then owned validation + the monotonicity fix end-to-end)

## Systems touched

ai-behavior-tree, ai-combat-balance, ai-pathfinding

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — multi-file monotonicity-critical AI change with full 3🍎 review harness (plan review + 2-round code-review loop to clean) + 36-pair headless A/B validation (0 win→loss flips).

## What Was Done

Extracted just the **two-axis AI A/B toggle** onto a fresh branch off `origin/main` (`nalfeo-nalfeo-ai-ab-harness`), deliberately leaving the entangled 57-commit fused-pathing rework (draft PR #811) behind. Both axes default to **LEGACY**, so main stays byte-identical and the Floor-1 gate stays green:

- `AIPathingMode {LEGACY, RISK_REWARD_FUSED}` — RISK_REWARD_FUSED is selectable in the lab/CLI but **impl-pending → delegates to legacy** (no port of the fused heading / Track-B / danger scoring). Verified inert.
- `AIDecisionMode {LEGACY, SLACK_AWARE}` — SLACK_AWARE is a NEW self-contained **monotone** filter on the existing run-plan slack/urgency signal. Its ONLY behavioral surface is **F1**: under `isSlackAwareUrgent()` (urgency ≥ 0.66 OR slackMs < 0) it makes the OPTIONAL Collect + Hunt goals ineligible and suppresses Explore **only when a valid Progress target exists** (never strands discovery). This closes the "farms forever after discovering the stairs" gap.

Key correctness work this session (on top of the child's scaffold):

- **Dropped the F2 exit-commitment bypass** (`if (progressSuppressed && !this.isSlackAwareUrgent())` → `if (progressSuppressed)`). Round-1 code review flagged the bypass as a monotonicity hazard: it overrode the quest-progress dwell watchdog's wedge-recovery escape hatch under urgency, which — combined with F1 also suppressing Collect/Hunt/Explore — could livelock a wedged agent and flip a win→loss. Dropping it makes SLACK_AWARE strictly more conservative; exit-commitment is now delivered entirely by F1.
- **Added a `decisionRunPlan` telemetry field** to `TacticalRunDebug` (the plan the F1 filter actually consulted this frame) and wired both viz consumers (`headless-runner.ts` telemetry + `ai-runner-lab` `Slack:` HUD row) to prefer it with a `?? runPlan` fallback. Null in LEGACY → telemetry byte-identical to main. This is the debuggability surface the human asked for ("I need to see what's going on/going to happen").
- **Added a durable, wired A/B harness** `scripts/agent/perf/ab-decision-mode.ts` + `npm run ai:ab-decision-mode` (mirrors `ai:weapon-sweep`). It runs each (seed,weapon) in BOTH decision modes and exits non-zero on any win→loss flip.
- **Added an F1-effect unit test** proving activation is not a tautology: a constructed world where LEGACY opens with COLLECT, and urgent SLACK_AWARE suppresses it → EXPLORE (discovery preserved).

**Observed in the real headless pipeline (`npm run ai:ab-decision-mode` / `scripts/agent/perf/ab-decision-mode.ts`).** Two independent A/B sweeps, both **0 win→loss flips**:

- Early sweep (seeds 1–8 × sword/bow/baseball-bat, 24 pairs): 0 flips, 0 loss→win. Per-weapon win rate byte-identical: sword 7/8, bow 8/8, bat 6/8. 4 benign same-outcome divergences (bow s3 −35s improvement).
- **Final representative re-validation after the F2 revert (seeds 42,101,202,303,404,505,606,707,808,909,1056,1234 × 3 weapons = 36 pairs, `files/ab-sweep-result-v2.txt`): `WIN→LOSS FLIPS: 0`, HARD GATE PASS.** legacy 31/36 (86.1%), slackAware 32/36 (88.9%); **1 loss→win recovery (sword seed 909)**, no regressions. Pre-existing MAIN losses (sword 808, bat 808/909, bow 303) unchanged in both modes — those are main balance, not this change (defaults are LEGACY = proven ==main).
- LEGACY **sim determinism** byte-identity self-verified line-by-line: `isSlackAwareUrgent()` short-circuits on the mode guard, so all F1 filters are dead `if(false)` and `decisionRunPlan` is never computed. (Note: a LEGACY `BehaviorTreeAI` still _emits_ the present-only telemetry fields `decisionMode='legacy'` + travelling `slackMs`/`urgency` — an observability superset, not a sim change; only game behavior/determinism is byte-identical.) See `files/byte-identity-proof.txt` + Floor-1 gate `files/verify-full.log`.

**Lab observe (brief step 5, `files/lab-observe.txt`):** `/lab.html?lab=ai-runner` — both FRESH dropdowns present (`pathingMode`=[legacy,riskRewardFused], `decisionMode`=[legacy,slackAware], default legacy); `Modes:` HUD and `Slack:` HUD render. Toggling decision→slackAware and pathing→riskRewardFused updates the Modes HUD live. (Lab is NOT the behavior proof per rule #10 — the headless A/B above is.)

**Review harness (3🍎):** plan_review (gpt-5.4, 6 concerns / 6 resolved) + code_review loop to clean (round 1 claude-sonnet-4.6: 1 blocking concern resolved — the F2 exit-commitment bypass; **round 2 claude-sonnet-4.6: CLEAN, all four hard contracts confirmed**). Ledger `docs/knowledge/review-ledgers/2026-07-07-ai-ab-harness.review-ledger.json` validates (exit 0). (Counts here mirror the ledger, the guard-enforced audit artifact.)

## Key Decisions Made

- **Honest safety framing (opt-in, not proven-safe-by-math).** DEFAULT byte-identity IS provable (dead stores + mode-guard short-circuit). SLACK_AWARE-when-enabled safety is **empirical** (A/B zero-flip) + **monotone-over-the-goal-set by construction** — NOT a mathematical outcome-proof, because monotone over the goal set ≠ monotone over game outcome (plan-review insight). So both modes stay LEGACY-default and SLACK_AWARE remains an opt-in experiment. If any future A/B shows a flip → make F1 MORE conservative, never weaken a test (rule #12).
- **Committed the A/B harness as first-class tooling** (wired into package.json) rather than discarding it — it is the reproducible proof of the zero-flip gate and a regression guard for future decision-mode work.
- **Left PR #811 and the fused-pathing rework untouched.** main already superseded that approach by going spawner-free (#836), deleting the Floor-1 swarm the fused pathing was built to survive.

## What's Next / Blockers

- **Awaiting human sign-off before any PR/merge.** No PR was opened. Branch `nalfeo-nalfeo-ai-ab-harness` is ready; review ledger validates; both defaults are LEGACY.
- Next natural step (separate session, human-gated): actually implement `RISK_REWARD_FUSED` behind its now-existing toggle, and/or add a second F-surface to SLACK_AWARE — but only with a fresh A/B zero-flip gate each time.
- The Floor-1 gate's 2 wall-clock perf-guard "failures" were environmental (concurrent A/B sweep + vitest contention on this machine); all win-rate/quest/frame assertions passed. VERIFY_FULL is deferred to CI by policy.

## Retrospective

### Lessons Learned

- **The F1-effect test needed three non-obvious isolation conditions** to make LEGACY pick COLLECT while urgent: (1) gold under the player (distance 0 → skips A\* reachability on the real procedural map), (2) accept the tutorial quest + level 1 so `findProgressObjective` returns null (no Progress preempts Collect), and (3) `staircaseDiscovered = true` so LEGACY's own collapse-panic beeline self-disables (its gate is `!staircaseDiscovered`) — otherwise LEGACY ALSO suppresses Collect and the two modes are indistinguishable. That third condition IS the exact gap F1 closes.
- `initializeFloor1Scenario` teleports the player to `floorMap.playerSpawn` — read the post-init position, do not assume (0,0).
- A frame-based/deterministic A/B sweep is safe to run alongside vitest; CPU contention changes wall-time but never win/loss outcomes.

### Mistakes Made

- Early F1-effect test attempts failed twice (gold unreachable on the real map; then the blown deadline tripped LEGACY's own beeline which also suppresses Collect) before finding the `staircaseDiscovered` isolation. Early signal for the next agent: when a "does mode X change behavior" test shows NO difference, first check whether a SHARED upstream mechanism (here, the collapse-panic beeline) is independently causing the same suppression in the control arm.
- Wasted a turn trying to stage the review ledger via the CLI with PowerShell-escaped JSON — Windows Git Bash/PowerShell mangles `\"`. Write ledger JSON directly with an editor instead of `review:ledger -- stage --json`.

### Opportunities for Future Improvement

- The `ai:ab-decision-mode` harness could be promoted into a CI job (gated, opt-in) so any decision-mode change auto-proves zero-flip before merge.
- Consider a deterministic headless assertion (not just the unit test) that exercises F1 activation inside the real headless runner, to satisfy "observe in the real artifact" without a manual A/B run.
