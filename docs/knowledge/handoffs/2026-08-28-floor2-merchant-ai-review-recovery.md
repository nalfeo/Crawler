# Floor 2 merchant AI review recovery

## Systems touched

ai-headless-runner, floor2

## Summary

Floor 2 CLI playtests left settlement-return routing disabled, so the headless
AI never revisited settlement merchants to evaluate and buy beneficial
equipment. `headless-runner-cli.ts` now resolves a **CLI-only** Floor 2 routing
default in a pure helper (`resolveHeadlessRunnerOptions`) and spreads the
resolved option into `runHeadless`.

Properties this deliberately preserves:

- The **runner's own** Floor 2 default stays off. Only the CLI defaults Floor 2
  on, so direct `runHeadless` callers and chained progression are unchanged.
  The runner-level default-off regression guard in
  `tests/headless/settlement-return-routing.test.ts` is retained.
- When routing is not resolved (Floor 1, Floor 3+), the key is **omitted
  entirely** rather than passed as `undefined`, so the runner's own
  `{ ...DEFAULT_CONFIG, ...config }` spread and its Floor 1 auto-enable branch
  still apply.
- `enforcePlayabilityInvariants` is **not** touched. Earlier superseded
  revisions set it to `false` on the Floor 2 path; the shipped code leaves the
  invariant gate enabled.

## Review recovery (this session)

Copilot review raised two findings against the previous revision:

1. The review ledger's plan-review note claimed the Floor 2 default-off test had
   been replaced with a real-pipeline default-on assertion. It had not — that
   test still asserts the runner default, and the only new coverage exercised
   the pure resolver, leaving the real CLI-to-runner wiring unverified under
   AGENTS.md rule 9.
2. The PR description still described a superseded implementation
   (`enforcePlayabilityInvariants: false`).

Fixes applied:

- Added `tests/unit/ai/headless-runner-cli-wiring.test.ts`, which loads the real
  `headless-runner-cli.ts` entrypoint and captures the exact config object it
  hands to the real `runHeadless` export. It asserts Floor 2 → `true`, Floor
  1/Floor 3 → key absent, explicit env opt-out forwarded as `false`, and
  `enforcePlayabilityInvariants` left unset.
- Added a real-pipeline headless test that feeds `parseArgs` +
  `resolveHeadlessRunnerOptions` output straight into `runHeadless` on Floor 2
  and asserts routing is enabled every frame with non-empty settlement-return
  telemetry — CLI resolution proven in the real headless artifact, not a lab.
- Corrected the ledger plan-review note and recorded a round-2 code review.
- Rewrote the PR description from the actual diff (AGENTS.md rule 10).

## Observe before done (rule 9)

Evidence comes from the real headless pipeline, not a lab:

- **Before:** `tests/headless/settlement-return-routing.test.ts` "emits zero
  settlement-return telemetry ... default-off configuration" still passes,
  showing a Floor 2 `runHeadless` run that omits the option produces zero
  routing telemetry.
- **After:** the new "enables Floor 2 settlement-return routing through the real
  CLI-resolved runner options" test drives the same `runHeadless` pipeline with
  the CLI-resolved options and observes `isSettlementReturnRoutingEnabled` true
  on every frame plus non-empty settlement-return telemetry.
- **Wiring proof:** the new unit wiring test was mutation-verified — reverting
  the entrypoint to `settlementReturnRouting: args.settlementReturnRouting`
  fails 2 of its 4 assertions.

## Verification

- `npx vitest run --project unit tests/unit/ai/headless-runner-cli-wiring.test.ts tests/unit/ai/headless-runner-cli-lib.test.ts` — 31 passed
- `npx vitest run --project headless tests/headless/settlement-return-routing.test.ts` — 9 passed
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-28-floor2-merchant-ai.review-ledger.json`

`scripts/agent/lab-gate-check.sh` was intentionally not run locally (Windows Git
Bash); CI's `check-format-and-labs` job enforces it.

## Unresolved issues

None.
