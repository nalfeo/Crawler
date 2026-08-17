# CI comment clarity

## Summary

Made exceptional CI comments accurate, concise, and bounded without changing the
underlying recovery or merge-train decisions.

## Systems touched

ci-policy, ci-recovery

## Apples

Estimated 3🍎, actual 3🍎 — five comment-rendering changes plus deterministic
coverage and CI structural-constant registration.

## Changes

- Unenforced conflict coordinator reports are explicitly advisory and no longer
  expose leader, slot, or merge-order language; rendering refreshes when the
  enforcement mode changes.
- Retroactive-plan comments report only absent qualifying issue-side evidence
  and state that they document review context rather than satisfy a pre-PR
  condition.
- Already-landed comments show a sorted 20-file evidence sample with an overflow
  count.
- Recovered merge-train receipts retain only the landed SHA, recovered status,
  and durable-proof revalidation statement.
- Incident comments link the first failed job and cap trusted promotion
  provenance at 4,000 characters.

## Verification

- Focused Node script tests: 163 passed.
- `npx vitest run tests/unit/ci-knobs-guard.test.ts --project unit` — 171 passed.
- `npm run verify:fast` — passed.
- Preflight initially could not find the Playwright executable; restored the
  lockfile dependency tree with `npm ci --ignore-scripts` before validation.
