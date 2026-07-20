# Session Handoff: Floor 2 equipment child-issue materialization

## Summary

Implemented `npm run epic:materialize` — a new CLI command that consumes the
deterministic `buildMaterializationPlan` output and creates the Floor 2
equipment slice/cloud-packet child GitHub issues through the repository-approved
`gh api` interface. The command is idempotent, requires explicit operator
confirmation, and records all created issue numbers in a single atomic write to
`epic-state.json`.

## Systems touched

`epic-status`

## Files changed

| File                                                                                        | Change                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `scripts/agent/epics/epic-status-lib.ts`                                                    | Added `GithubWriteRunner` interface, `createGhWriteRunner()`, `materializeChildIssues()`, `patchEpicStateIssues()`, and supporting helpers (`listIssuesByLabels`, `extractNodeIdFromBody`) |
| `scripts/agent/epics/epic-materialize.ts`                                                   | New CLI script: `npm run epic:materialize -- floor-2-equipment [--dry-run                                                                                                                  | --confirm] [--json]` |
| `package.json`                                                                              | Added `epic:materialize` npm script                                                                                                                                                        |
| `tests/unit/agent/epic-materialize.test.ts`                                                 | 16 unit tests covering dry-run, confirm, idempotency, body-marker matching, state-patch, no-overwrite, and invariants                                                                      |
| `docs/knowledge/review-ledgers/2026-07-19-floor-2-equipment-materialize.review-ledger.json` | Review ledger (3🍎: plan_review + code_review)                                                                                                                                             |

## Verification run

```
npm run verify:fast   # 1295 tests pass, typecheck + lint clean
npm run typecheck     # clean
```

Tests: `tests/unit/agent/epic-materialize.test.ts` — 16/16 pass.
Tests: `tests/unit/agent/epic-status.test.ts` — 71/71 pass (no regressions).

## Key design decisions

1. **Idempotency via stable `Node: \`<node_id>\`` body marker** — issues bodies
   written by `buildMaterializationPlan` always contain `Node: \`<node_id>\``.
`listIssuesByLabels`fetches all issues (open + closed) with`state=all` and
   matches by this marker first (immune to title edits), with exact title as
   fallback. This prevents duplicates even when:
   - an issue was previously created but not yet recorded in state
   - an issue title was edited after creation
   - an issue was closed and re-run is attempted

2. **Single atomic state write** — all created/discovered issue numbers are
   collected in memory first, then `patchEpicStateIssues` does one JSON read +
   write. This ensures the state file is never left in a partially-updated state.

3. **`--dry-run` default** — running `epic:materialize` without flags defaults
   to dry-run (read-only). The operator must pass `--confirm` explicitly for any
   writes. This satisfies the "require explicit operator confirmation; no silent
   bulk writes" requirement.

4. **PR filtering** — `listIssuesByLabels` filters out pull requests (which
   GitHub's Issues API can return for the same labels) by checking for the
   `pull_request` field.

5. **Post-run hard-error check** — after `patchEpicStateIssues`, the CLI
   re-validates offline and exits with code 1 if non-git-verification errors are
   found, preventing the operator from committing a broken state update silently.

## Acceptance criteria verification

- `--dry-run` output matches `buildMaterializationPlan` exactly (same 35 nodes, topological order).
- `--confirm` creates each missing issue once and reports existing matches as `existing` (no mutation).
- A second `--confirm` run produces zero new issues (plan is empty when all nodes have `github.issue` set).
- After committing `epic-state.json`, operator should run: `npm run epic:status -- floor-2-equipment --github --reconcile` to confirm no missing materialization blockers.

## Unresolved issues

None. The `state=all` + node_id body marker approach fully addresses idempotency across all scenarios.

## Recommended next steps

1. Run `npm run epic:materialize -- floor-2-equipment --dry-run` to verify the
   35-node plan looks correct.
2. Run `npm run epic:materialize -- floor-2-equipment --confirm` to create all
   child issues.
3. Commit the updated `epic-state.json` (contains 35 new issue references).
4. Run `npm run epic:status -- floor-2-equipment --github --reconcile` to verify
   no missing materialization blockers remain.
5. Dispatch only nodes in the computed ready queue (starting with slice:A1 once
   slice:A0 is merged and validated).

## Apples

Estimated: 3🍎 (Medium). Actual: 3🍎.
