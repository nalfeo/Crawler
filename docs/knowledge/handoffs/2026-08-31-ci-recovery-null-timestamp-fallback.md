# Session Handoff: CI recovery null timestamp fallback

## Date

2026-08-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎 exact (review readability cleanup)

## Summary

Replaced the human-escalation `-Infinity` timestamp sentinel with an explicit `null` fallback when
no finite escalation timestamp is available.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `docs/knowledge/handoffs/2026-08-31-ci-recovery-null-timestamp-fallback.md`

## Verification

- `npm run format:check -- .github/scripts/ci-recovery/reconcile.mjs docs/knowledge/handoffs/2026-08-31-ci-recovery-null-timestamp-fallback.md`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs --test-name-pattern='human-escalation|KEEP after|stale KEEP'`

## Unresolved issues

- None known.

## Recommended next steps

- Let CI run the full PR gate.
