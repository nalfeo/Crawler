# Session Handoff: Floor 2 epic control PR recovery

## Date

2026-07-17

## Persona

Producer / DevOps Engineer

## Systems touched

ci-policy, docs-tooling, mcp-tooling

## Apples

3 apples estimated -> 3 apples actual. Full JSON:
`docs/knowledge/metrics/apples/2026-07-17-floor-2-epic-control-pr-recovery.json`.

## What Was Done

Recovered PR #1286's epic-control blockers without widening scope beyond the
control-plane files:

- Added the advertised speculative stacked-work contract to the Floor 2 epic
  plan/schema/state: `STACKED-WORK` protocol heading, `stackBase` /
  `stackedWork` schema, and optional `stacked_work` node metadata.
- Extended `epic-status-lib.ts` to validate stacked-work lifecycle/base drift,
  prevent stacked nodes from entering the authoritative ready queue, detect
  duplicate speculative sessions/issues, and audit speculative PR head/state
  drift.
- Tightened git commit verification to peel to commits only.
- Suppressed `ready_queue` output when global validation errors exist.
- Replaced the old schema spot-check with stronger deterministic contract-parity
  checks covering root consts, required/additionalProperties guarantees, stacked
  work refs, and GitHub issue/PR URL patterns.
- Fixed GitHub claim folding so claimant+session are the live-owner identity and
  later expired replacements revoke earlier live claims.
- Hardened PR head-drift handling so stale handoff/review evidence blocks open
  PRs, while merged/validated nodes rely on merge facts instead of mutable branch
  heads.
- Added focused unit regressions for all repaired behaviors.

## Review and Validation

- Separate-model plan review (`gpt-5.4`): 5 concerns adopted, divergence `minor`.
- Code-review clean-confirmation round (`gpt-5.3-codex`): no validated findings
  remaining after fixes.
- Focused suite: `npx vitest run tests/unit/agent/epic-status.test.ts` (37/37
  passing).
- Offline epic control surface: `npm run epic:status -- floor-2-equipment`
  passes (expected blockers only for the still-unmaterialized downstream nodes).
- `npm run verify:fast` passes.
- `npm run review:ledger -- validate
docs/knowledge/review-ledgers/2026-07-17-floor-2-epic-control-pr-recovery.review-ledger.json`
  passes.
- Local `npm run epic:status -- floor-2-equipment --github --reconcile` still
  hits `gh api` 403 in this sandbox, so live PR/check state was verified via
  GitHub MCP instead; required PR checks were green/in-progress with no failing
  required checks at validation time.

## Recovery

If another session continues this PR, start from:

1. `npm run epic:status -- floor-2-equipment`
2. `npm run verify:fast`
3. `npm run verify:pr-prereqs`
4. read `docs/knowledge/review-ledgers/2026-07-17-floor-2-epic-control-pr-recovery.review-ledger.json`
5. verify current PR/check state via GitHub MCP before resolving threads or
   arming merge automation.

## What's Next

- Commit/push the repaired control-plane changes.
- Reply `✅ Addressed in <sha>: ...` on the six listed review threads and resolve
  only the deterministically addressed ones.
- Re-check PR status/required checks after the push-triggered runs start.
