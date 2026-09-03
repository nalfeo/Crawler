# Run Bundle Analysis Skill

**Date:** 2026-09-03  
**Persona:** Producer → DevOps Engineer  
**Apples:** 2🍎 estimated / 2🍎 actual (exact)

## Systems touched

mcp-tooling

## Summary

Added the `run-bundle-analysis` skill for evidence-backed diagnosis whenever an
issue, PR, handoff, or request includes a local `bundle.json` or run-bundle URL.
The workflow parses the canonical `meta`, `runStats`, `recorderJsonl`, and
`logs` channels, correlates timeline evidence, distinguishes observation from
inference, and reports missing or contradictory telemetry without treating
absent optional fields as zero.

The skill is read-only and uses existing JSON tooling. It adds no dependency,
runtime gameplay change, CI gate, or duplicate parser.

## Files touched

- `.github/skills/run-bundle-analysis/SKILL.md`
- `tests/unit/run-bundle-analysis-skill.test.ts`
- `docs/knowledge/handoffs/2026-09-03-run-bundle-analysis-skill.md`

## Verification

- The supplied signed Azure URL was attempted before implementation, but this
  sandbox could not resolve the blob hostname. The failure was treated as
  `bundle unavailable`, not as a clean bundle.
- A representative bundle in `/tmp` verified the analysis workflow identifies
  an outcome contradiction, retains valid recorder line numbers around a
  malformed JSONL line, and labels an omitted optional metric `not recorded`.
- `npx vitest run --project unit tests/unit/run-bundle-analysis-skill.test.ts --reporter=dot`
  — 4/4 passed.
- `npx prettier --check tests/unit/run-bundle-analysis-skill.test.ts .github/skills/run-bundle-analysis/SKILL.md`
  — passed.
- `bash scripts/agent/verify-fast.sh` — passed typecheck/lint, changed tests,
  and data-contract/integrity/coverage checks.

## Unresolved issues

None.
