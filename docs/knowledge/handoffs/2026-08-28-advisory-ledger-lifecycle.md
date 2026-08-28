# Handoff — Advisory ledger publication lifecycle

## Systems touched

ci-policy

## Summary

- PR creation and draft publication no longer block on missing or invalid review ledgers.
- Required CI validates added ledgers, while CI Recovery classifies invalid ledgers and assigns final-head repair.
- Native GitHub Copilot reviews can supply code-review provenance through reviewer actor and review URL fields.

## Apples

- Estimated: 3🍎
- Actual: 3🍎

## Validation

- `npm run test:guards` — 2937 passed.
- `npm run verify:fast` — 8480 passed.
- `npm run format:check` — passed.
- Focused CI Recovery reconciliation tests — passed.
- Independent grade — 5/5 across all criteria.
- `npm run docs:check` — blocked by an unrelated stale path in inaccessible `.github/agents/ux-designer.agent.md`.
