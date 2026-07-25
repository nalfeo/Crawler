# Sprite reconciler Git identity hotfix

**Date:** 2026-07-25
**Persona:** DevOps Engineer
**Apples:** 1 estimated, 1 actual (exact)

## Systems touched

sprite-workflow, ci-policy

## Outcome

The Sprite queue reconciler now configures a repository-local
`github-actions[bot]` author identity after authenticating Git. This prevents
the promotion commit from failing with `Author identity unknown` before
`assets/promote` can be pushed.

## Validation

- `npm run verify:fast`
- Confirmed the isolated hotfix diff applies cleanly to current `origin/main`.
