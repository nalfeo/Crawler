# Handoff — Workflow Candidate Detail Sidebar

**Date:** 2026-06-27
**Session:** workflow-candidate-detail-panel
**Persona:** Producer
**Apple estimate:** 🍎🍎🍎 | **Actual:** 🍎🍎🍎 | **Verdict:** 🎯 exact

## Why

Follow-up UX polish on the merged PR2 7-stage sprite workflow. While running the
live skull-mace flow, the operator hit three concrete gaps on the run-candidate
cards in the PostProcess/Judge panel:

1. **Cryptic judge scores.** The cards show only single-letter chips `S 5 / B 4 /
R 3` with no axis names, no tooltip, and no rationale — you can't tell what
   `S`/`B`/`R` mean or read the model's reasoning.
2. **No judge results on the other 7/7-sensor sprites.** Variants past the judge
   cap (`judgeSkipReason: 'over-cap'`) carry `judge: null`, so they render no
   chips at all — looking un-evaluated with no explanation.
3. **False "sensor fail" on a passing variant.** A variant that passed every
   sensor but was never judged (`passed: true`, `combinedPassed: false`,
   `judge: null`) was mislabeled red **"sensor fail"**.

The operator asked for the **sprite-gallery lab's detail sidebar, embedded in the
workflow** (click a candidate → open the full scorecard + sensor detail) —
explicitly **not** a link out to the lab.

## What Was Done

### 1. Correct status classification (fixes issue #3)

New pure helper `candidateStatus()` in `src/devtools/sprite-workflow-queue.ts`
replaces the inline ternary that fell through to "sensor fail". It uses the
authoritative `passed` / `combinedPassed` / `judge.passed` flags to return one of
four kinds:

- `pass` → "PASS" (green)
- `sensor-failed` → "sensor fail" (red) — only when `passed` is actually false
- `judge-rejected` → "judge fail" (red) — sensors passed, judge rejected
- `unjudged` → "not judged" (neutral gray) — sensors passed, no verdict yet

The card header + the new detail pill both consume it, so a sensor-passing /
unjudged variant can never read as a sensor failure again.

### 2. `describeJudgeSkipReason()` (explains issue #2)

New pure helper maps the sidecar's `JudgeSkipReason` (`'sensor-failed' |
'over-cap' | 'over-budget' | 'judge-disabled'`) to operator-facing text, e.g.
over-cap → "only the top variants (by sensor score) are judged to bound cost.
Raise the brief's judge.maxVariants to judge more." Surfaced in the detail panel
so a `judge: null` variant explains _why_ rather than looking broken.

### 3. Candidate detail sidebar (the feature)

Clicking a candidate's sprite opens an inline `<aside>` panel
(`src/devtools-main.ts`) that mirrors the gallery's detail view:

- **Variant header + status pill** (uses `candidateStatus`).
- **Judge (advisory) section** with the **named** axes — Style match / Brief
  match / Readability — each with `score/5 ✓/✗` and, when enriched, the model's
  **per-axis rationale**; plus the verdict, lowest axis, rejected-by list, and
  model/timestamp provenance. When unjudged, shows the skip-reason text instead.
- **Sensors section** — every sensor with pass/fail + reason + pixel magnitude.
- **Raw candidate JSON** `<details>` — full parity with the gallery.

Data strategy: the base panel renders **instantly from persisted queue state**
(axis names, scores, sensors, correct status — works offline and after a
refresh). It then **best-effort fetches `GET /api/runs/:b/:r`** to enrich with
per-axis rationale + precise skip reason + raw JSON. If the sidecar is
unreachable the base panel stands — no crash, no spinner-of-death. Selection is
scoped per-run (`{key,index}`) so it never leaks across runs; the summary fetch
is deduped and cached.

### 4. Card tooltip (cheap win for issue #1)

The `S`/`B`/`R` chips now carry a `title` tooltip (e.g. "Style match: 5/5
(pass)") so the cards are legible without opening the panel.

## Files Changed

| File                                                | Change                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/devtools/sprite-workflow-queue.ts`             | + `candidateStatus()`, `describeJudgeSkipReason()`, types (pure)                  |
| `src/devtools-main.ts`                              | Detail sidebar; clickable sprites; `candidateStatus` label/color; chip tooltips   |
| `tests/unit/devtools-sprite-workflow-queue.test.ts` | +13 tests (all 4 status kinds incl. the unjudged regression; skip-reason mapping) |
| `tests/e2e/sprite-workflow-sensors.test.ts`         | +1 CI-safe test: unjudged label + click-opens-detail-with-named-axes              |

## Validation

- `npm run typecheck` ✓ · `npm run lint` ✓ · `npm run format` ✓
- `npm run verify` ✓ through unit (616+13) / coverage / integration (49) — the
  **only** failure was the headless Floor 1 `seed 7 · bow` **wall-time** perf
  guard (35.5s > 30s). Re-ran `tests/headless/floor1-completion.test.ts` in
  isolation on the idle box → **60/60 green**. Confirmed environmental (contended
  box during the full run); my changes are devtools/sprite-workflow UI only and
  are not imported by the game ECS/AI hot path, so they cannot affect Floor 1
  wall time. Same environmental pattern noted for PR2b-2 in plan.md.
- `npm run test:e2e` ✓ (21/21 across 5 specs, incl. the new detail-panel test)
- `bash scripts/agent/lab-gate-check.sh` ✓ (no new ECS system)
- Visual evidence: `tmp/e2e-screenshots/sprite-workflow-detail-panel.png` (not
  committed) shows the open panel with Style match 5/5 ✓ / Brief match 4/5 ✓ /
  Readability 4/5 ✓ and a variant correctly labeled "not judged".

## Notes for Next Agent

- The per-axis **rationale** only appears after the sidecar enrich fetch — the
  CI-safe e2e aborts `/api/**`, so it asserts only persisted-state content (axis
  names, scores, sensors, status). Don't assert rationale text in CI.
- The base panel deliberately renders even when `summary.json` is unreachable;
  this is the graceful-degradation path, not a bug.
- `candidateStatus` / `describeJudgeSkipReason` are pure and exported — reuse them
  if the Approve/Tag stages later need the same labels.
- No `files/guard-telemetry.jsonl` this session, so no guard-telemetry section.

## Apples

Estimated 🍎🍎🍎, actual 🍎🍎🍎 (exact). Two pure helpers with full unit
coverage, one real UI surface in the large `devtools-main.ts` (instant-render +
async-enrich + per-run selection state), and a CI-safe e2e — but it **reused**
the existing `summary.json` endpoint, `el()` helper, and persisted
`WorkflowRunCandidate` shape rather than building new data plumbing, landing
squarely at the Medium estimate.
