# Merge Train Rollout Fix

## Date

2026-07-14

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3 apples estimated, 3 apples actual

## What Was Done

- Added deterministic Git author and committer identity to candidate squash
  assembly so hosted runners do not reject the merge before the synthetic commit.
- Separated repository App promotion authentication from the built-in Actions
  token used to dispatch CI Recovery and Merge Train Validation workflows.
- Changed candidate failure classification so only a non-empty unmerged index is
  treated as a cumulative conflict. Operational Git failures remain retryable and
  do not falsely block or de-admit a PR.
- Added regression coverage for Git identity, token-role enforcement, both
  workflow dispatch paths, real conflicts, and retryable operational failures.

## Validation

- CI Recovery and merge-train automation suites: 130 passed, 0 failed.
- `npm run verify:fast` passed under Node 22 after restoring the platform-specific
  Rolldown optional dependency in the local worktree.
- Separate-model plan review completed after adopting all five findings.
- Separate-model code review found no significant concerns.

## Rollout

The repository remains on the legacy merge path while this fix lands. After
merge, enable `MERGE_TRAIN_ENABLED`, explicitly reconcile one eligible same-repo
PR, and require a successful real Merge Train Validation run plus the expected
post-validation state. Only then restore `merge-train` as a required `main`
status context. If the canary fails, disable the flag before changing branch
protection.

## Retrospective

### Lessons Learned

The initial rollout tests covered deterministic synthetic commits but did not
exercise hosted-runner identity or the distinct permission boundary between
repository App tokens and the workflow's built-in Actions token. The corrected
tests now make both runtime assumptions explicit.

### Mistakes Made

Tests relied only on synthetic commits without verifying the hosted-runner
permission model, masking the App token vs. Actions token identity boundary
until the first real CI run.

### Opportunities for Future Improvement

Any future workflow identity or permission change should update the rollout
tests first, so the boundary assumptions are validated before deployment rather
than discovered at canary time.
