# Goobers and Cloud assignment ownership fence

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**
- Apple actual: **3**

## Summary

Centralized the live issue-ownership fence used before issue-level Cloud Copilot
assignment. Standard intake, nightly issue filers, baseline regressions, harvest
liveness incidents, and CI Recovery incidents now all observe
`LIFECYCLE_MUTATION_OWNER`; a live `goobers/status:in-review` claim is refused
even if another assignee appears or the selector is rolled back.

Goobers intake now treats every open same-repository PR cross-reference as
existing implementation work, regardless of branch name. The post-run release
path remains restricted to Goobers PRs, preserving its conservative rollback
behavior and all PR-lifecycle lane ownership.

## Tests

- Shared live-state race tests cover claims appearing before assignment and
  claims with a concurrent non-Copilot assignee.
- Harvest incident assignment has a dedicated claim-race regression.
- Structural tests enumerate every assigning workflow selector and every direct
  assignment callsite.
- Workflow structure asserts the intake PR fence has no branch-name predicate.

## Verification

See the session closeout for exact command results.
