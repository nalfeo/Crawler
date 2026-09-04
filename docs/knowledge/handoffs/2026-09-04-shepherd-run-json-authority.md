# 2026-09-04 Shepherd run JSON authority

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## Summary

Made the bounded `gh run view --json` result authoritative for Shepherd's final
workflow verdict. A non-zero `gh run watch` exit is now diagnostic-only when
the completed run JSON reports success, and is logged as
`watcher-json-disagreement`.

The Shepherd status helper now distinguishes genuine failed jobs from
`cancelled`, `action_required`, and non-failure terminal conclusions. A failed
job on a run that has not completed (or that was cancelled) is reported but
never recommends a `--log-failed` read, so only a JSON-confirmed failure is
treated as a verdict. The
playbook directs operators to make one final JSON read after completion — issued
by the producer command itself, so the recipe never takes a second, divergent
snapshot — and to inspect logs only after that read identifies a real failure.

Scope is Shepherd status tooling only. Floor 3 AI-runner, scene interaction, lab,
E2E, and CI-timeout changes briefly appeared in this branch's diff because the
branch trailed `main`; they belong to PR #4183 and are unchanged here. Syncing
`main` cleared them from the diff.

## Files touched

- `scripts/agent/producer.ts`
- `tests/unit/producer.test.ts`
- `.github/skills/pr-shepherd/references/playbook.md`
- `docs/knowledge/handoffs/2026-09-04-shepherd-run-json-authority.md`
- `docs/knowledge/metrics/apples/2026-09-04-shepherd-run-json-authority.json`

## Verification

- GitHub Actions MCP: run `33730214117` and a job log confirmed
  `completed/success` despite the reported watcher exit 1.
- `npm run test:unit -- tests/unit/producer.test.ts` (45 passing)
- `npx eslint scripts/agent/producer.ts tests/unit/producer.test.ts`
- `npm run typecheck`
- `npm run docs:check`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- The local `gh` CLI has no `GH_TOKEN`, so the live status CLI invocation could
  not be exercised in this sandbox. The pure classifier is covered
  deterministically, and the documented run was independently verified through
  GitHub Actions MCP.

## Recommended next steps

- None. CI Recovery is already event-driven and makes bounded run/job API reads,
  so no CI Recovery code path required changing.
