# Handoff: Shrink agent startup contract

**Date:** 2026-09-10
**Apple estimate:** 🍎🍎
**Actual:** 🍎🍎

## Systems touched

docs-tooling, agent-personas, ci-policy

## Outcome

Reduced the root `AGENTS.md` from 54,710 to 5,856 characters while retaining
the deterministic session-policy lines enforced by `docs:check`, safety and
architecture boundaries, scoped validation, and PR-publication rules.

The exhaustive command table and unconditional bulk-reading workflow were
replaced with a scoped lookup map that points to the existing canonical docs.

## Validation

- `npm run docs:check` — passed with zero blocking findings.
- `npm run verify:pr-prereqs` — passed.
- `git diff --check` — passed.

## Notes

No runtime or game code changed. The command-inventory notices from
`docs-check-readme-commands` are informational and expected after deliberately
removing the catalog from `AGENTS.md`.
