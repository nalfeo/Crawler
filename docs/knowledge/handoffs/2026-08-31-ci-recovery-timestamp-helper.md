# Session Handoff: CI recovery timestamp helper

## Date

2026-08-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎 exact (review readability cleanup)

## Summary

Extracted the newest finite timestamp calculation for human-escalation declarations and made the
`KEEP` override helper reject the explicit `null` timestamp sentinel.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `docs/knowledge/handoffs/2026-08-31-ci-recovery-timestamp-helper.md`

## Verification

- `npm run format:check -- .github/scripts/ci-recovery/reconcile.mjs docs/knowledge/handoffs/2026-08-31-ci-recovery-timestamp-helper.md`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs --test-name-pattern='human-escalation|KEEP after|stale KEEP'`

## Unresolved issues

- None known.

## Recommended next steps

- Let CI run the full PR gate.
