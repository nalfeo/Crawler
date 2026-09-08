# Session Handoff: Canonicalize Goobers repass context and gate loop

## Date

2026-09-07

## Persona

Producer

## Systems touched

ci-policy,agent-memory

## Apples

2🍎 estimated

## What Was Done

Updated the Goobers feature-PR workflow to enforce the current-only repass contract described in issue #4442: `implement` now consumes only the canonical requirements artifact and materialized producer plan, the task graph runs `implement -> push-branch -> local-ci -> local-gate -> review -> open-pr`, and deterministic local verification failures loop directly back to `implement` instead of entering an agent review pass.

The review gate now waits until after `verify:fast` succeeds and caps automatic review repasses at 2 instead of 6. The workflow contract test was updated to assert the exact ordering, `contextFrom` payload, pass branches, and repass cap so the policy remains enforced by deterministic checks.

## Key Decisions Made

- Kept the canonical repass contract bounded to the latest applicable stage evidence only: requirements + producer plan for initial implementation, and the newest reviewer/local-gate defect evidence for subsequent passes — `implement.contextFrom` lists `local-ci` and `review` alongside the requirements/plan sources so the pinned runtime's `SelectContextPointers` carries forward `local-ci.artifact[...]`/`review.verdict` on a repass; both resolve to nothing on the initial pass since neither task has run yet.
- Placed the local verification gate before the reviewer so the task order matches the intended "implement -> local fast verification -> review -> push/open PR" pipeline and avoids review churn on deterministic local failures.
- Preserved the explicit human escalation branches while tightening the workflow cap to the documented two-repass ceiling.

## What's Next / Blockers

No blockers remain in this worktree for the workflow contract fix itself. The repo's broader PR-prereq gate still expects a new handoff file in this branch before publication, which is satisfied by this document.

## Retrospective

### Lessons Learned

The workflow contract was correct in spirit but the repass loop still had stale self-context and the reviewer gate ran too early. Reducing the contract to one canonical requirements artifact, one canonical plan artifact, and a deterministic local-gate-first ordering resolved the drift without widening trust or credential scope.

### Mistakes Made

None significant.

### Opportunities for Future Improvement

If the Goobers runtime later adds a schema-level validator for per-stage context payloads, the same canonical contract should be mirrored there so the workflow YAML and runtime enforcement stay in sync.
