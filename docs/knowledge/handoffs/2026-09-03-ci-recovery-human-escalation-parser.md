# 2026-09-03 CI recovery human-escalation parser

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## Summary

Investigated CI recovery loop incident #4122 for PR #4115. The linked blocker was a review thread where the recovery agent had corrected the in-repo handoff but could not edit the PR body closing keyword, then left the thread unresolved for a maintainer/permissioned actor to update PR metadata.

The CI Recovery run itself succeeded, but classified the PR as stale automation exhausted because `isHumanEscalationDeclaration()` only recognized clauses that literally said the agent was escalating to a human. The PR #4115 wording instead said the thread was left unresolved and that a maintainer or permissioned agent needed to manually change the PR description. That failed to set `humanEscalationDeclared`, so the existing human-decision quarantine path was never reached.

## Files touched

- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`
- `docs/knowledge/handoffs/2026-09-03-ci-recovery-human-escalation-parser.md`
- `docs/knowledge/metrics/apples/2026-09-03-ci-recovery-human-escalation-parser.json`

## Verification

- `bash scripts/agent/preflight.sh`
- Fetched PR #4115 review thread evidence via GitHub MCP: `discussion_r3918490098`
- Fetched CI Recovery run 33700265680 jobs/logs via GitHub MCP
- `node --test .github/scripts/ci-recovery/state.test.mjs`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `git diff --check`
- `npm run verify:fast`
- `npm run sync:main -- --reason pre-publish`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None known for the CI recovery parser fix.
- PR #4115 itself still requires a maintainer or permissioned actor to change the PR body from `Fixes #3980` to `Related to #3980`; this fix prevents CI Recovery from repeatedly dispatching agents for that terminal human-decision state.

## Recommended next steps

- After this lands, CI Recovery should quarantine equivalent unresolved maintainer-action review replies instead of filing automation-loop incidents.
- Keep the parser strict: require a non-conditional unresolved declaration plus either explicit human escalation or an external maintainer/owner/permissioned-agent action requirement in the same clause.
