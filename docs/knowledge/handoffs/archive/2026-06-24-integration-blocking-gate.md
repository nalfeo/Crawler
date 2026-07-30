# Session Handoff: sprite/judge integration tests → blocking CI gate (PR Group D — Item 9)

## Date

2026-06-24

## Persona(s) adopted

QA — verifying test honesty and closing a CI gating gap; no production code change.

## Routing verdict

✅ right persona — CI-config + test-honesty work, no game-logic changes.

## Apples

Estimated: 🍎🍎
Actual: 🍎 (under — the tests were already deterministic; the only work was
confirming green + promoting the CI job)
Verdict: ⬇️ Under

Hello kitties: 1/5 = 0.20 🎀

## What Was Done

Picked up PR Group D, Item 9. Prior handoffs (`2026-06-19-e2e-sprite-workflow`,
`2026-06-20-coverage-improvement-loop`) repeatedly described
`tests/integration/generate-one.test.ts`, `judge-pipeline.test.ts`, and
`judge-budget-cache.test.ts` as "pre-existing failures needing external
VLM/image providers."

**Ground truth:** ran all three — **13/13 pass, deterministic**, exit 0. They
use mock `ImageProvider` / `VisionProvider` implementations and temp fixtures;
there is **no external VLM/image dependency**. The "pre-existing failures"
framing was stale/incorrect.

The honest gap (AGENTS.md rule #8 forbids leaving tests as
"pre-existing/unrelated"): `npm run verify` (verify.sh Step 6) already gates the
full integration project locally, but in **CI** the integration tests ran only
inside the `ci-advisory` job with `continue-on-error: true` — i.e. non-blocking.
So a future regression in these tests could merge silently.

**Change:** promoted integration from advisory to a blocking gate in
`.github/workflows/ci.yml`:

1. Added a dedicated **`test-integration`** job (mirrors `test-unit`) running
   `npx vitest run --project integration --reporter=verbose`.
2. Removed the redundant "Integration tests" step from `ci-advisory`.
3. Wired `test-integration` into `merge-gate.needs` and added a `check` line so
   a failure blocks merge.

## Files Touched

- `.github/workflows/ci.yml`

## Verification Run

- Confirmed the 3 sprite/judge tests pass deterministically (13/13).
- Ran the **full** integration project locally: `npx vitest run --project
integration` → **24 passed / 1 skipped**, exit 0 (the 1 skip is
  `sidecar-lifecycle.test.ts`, which is `describe.skipIf(isWindows)` — a
  Linux-only POSIX-signal lifecycle test, not an external-provider skip).
- YAML validated (parses; `merge-gate.needs` includes `test-integration`).
- The Linux-only sidecar path is exercised by the PR's own CI run on the new
  blocking job.

## What's Next

- Watch the PR's "Integration Tests" check to confirm the Linux-only sidecar
  lifecycle test is green on the blocking job (it previously ran in advisory CI).
- Item 18 (sibling branch): inventory + mobile e2e/visual regression.

## Blockers

None.

## Branch State

- Branch: `test/sprite-judge-integration-green`
- All tests passing: yes (integration 24 passed / 1 skipped locally)
- PR created: yes (PR Group D — Item 9)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` exists for this session; the single recorded event
was the `pr-preflight` deny on Item 7 before its handoff existed (now resolved).
No new guard denials for this item.
