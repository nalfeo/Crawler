# Session Handoff: Default core sprite outputs to 256x256

## Date

2026-07-31

## Systems touched

sprite-pipeline, ci-policy

## Apples

Estimated: 2

Actual: 2

## Summary

Set the default final sprite output size to 256x256 for the core gameplay-facing
types (`character`, `enemy`, `prop`, `equipment`) while preserving explicit
per-brief size overrides.

Aligned resize post-processing defaults with the same 256 baseline by updating
`trim-and-fit` min-dimension defaults in the base template, schema defaults,
and runtime fallback path.

Also carried the emergency dependency rollback for the mirror outage
(`postcss` override rollback to 8.5.22 plus temporary audit exception wiring)
so installs and security audit remain unblocked in this window.

## Files touched

- `data/sprite-types/character.json`
- `data/sprite-types/enemy.json`
- `data/sprite-types/prop.json`
- `data/sprite-types/equipment.json`
- `scripts/sprites/templates/base.yml`
- `scripts/sprites/brief-schema.ts`
- `scripts/sprites/postprocess-modules.ts`
- `tests/unit/sprites/load-brief.test.ts`
- `tests/unit/sprites/brief-schema.test.ts`
- `package.json`
- `package-lock.json`
- `scripts/agent/security/npm-audit.mjs`
- `scripts/agent/security/npm-audit.test.mjs`

## Verification run

- `npm run test:sprites -- tests/unit/sprites/load-brief.test.ts tests/unit/sprites/brief-schema.test.ts`
- `npm run security:audit`
- `npm run review:ledger -- validate docs\knowledge\review-ledgers\2026-07-31-default-256-sprite-output-size.review-ledger.json`

## Unresolved issues

None.

## Recommended next steps

Let CI run full branch gates and merge if green.
