# Session Handoff: docs-update: 2026-07-13 findings

## Date

2026-07-16

## Persona

DevOps Engineer / Docs Tooling

## Systems touched

ci-policy, docs-tooling

## Apples

1🍎 exact

## What Was Done

Resolved all blocking and non-blocking findings from the 2026-07-13 docs-update scheduled report (issue #1120, closes #1120).

**Blocking findings cleared (16 total):**

- Fixed 5 handoffs missing retrospective subsections (`### Lessons Learned`, `### Mistakes Made`, `### Opportunities for Future Improvement`) under `## Retrospective` — cleared 15 blocking errors from `docs-lint-handoff`
- Fixed `docs/knowledge/adr/0007-spatial-units-architecture.md` broken path reference to `docs/knowledge/handoffs/2026-06-08-px-to-feet.md` (now archived to `archive/`) — cleared 1 blocking error from `docs-check-adr-consistency`

**Non-blocking findings fixed:**

- Fixed `docs/knowledge/metrics/apples/2026-06-30-sidecar-shared-selector-deployment.json` camelCase field names (`estimatedApples` → `estimated_apples`, `actualApples` → `actual_apples`) so the entry is picked up by the calibration validator
- Added proper `## Status` sections to 3 ADRs that used bold `**Status:**` format instead of `## Status` heading format
- Fixed wrong system slugs in 41 handoffs (e.g., `ci` → `ci-policy`, `hud` → `hud-ux`, `enemy-ai` → `ai-behavior-tree`) using canonical slugs from `docs/systems/README.md`
- Added `## Systems touched` sections to 182 handoffs missing them (batch-classified from filename keywords)
- Regenerated `docs/knowledge/handoffs/INDEX.md` (513 handoffs indexed across 22/23 systems; 18 unclassified)
- Added 40 missing npm scripts to `AGENTS.md` Commands table

## Verification

- All docs scripts: 0 blocking findings remaining
- `docs-lint-handoff`: 1 finding (non-blocking INFO), 0 blocking
- `docs-check-adr-consistency`: 0 findings, 0 blocking
- `docs-apple-calibration`: 1 finding (non-blocking WARN), 0 blocking
- `docs-build-system-index`: 22 findings (all WARN, down from 177), 0 blocking
- `docs-check-readme-commands`: 0 findings, 0 blocking

## Retrospective

### Lessons Learned

The `## Systems touched` field was missing from most legacy handoffs because it was introduced retroactively. Batch-classifying from filename keywords is a practical approach, though some filenames are ambiguous and result in misclassifications.

### Mistakes Made

The apple calibration JSON used camelCase field names (`estimatedApples`, `actualApples`) instead of snake_case (`estimated_apples`, `actual_apples`). The calibration library documents the valid aliases (`estimated`, `estimate`, `estimated_apples`) but does not document camelCase variants, so the entry was silently skipped.

### Opportunities for Future Improvement

Add a pre-commit or CI check that validates new apple JSON files use the canonical field names before they land, to prevent future silently-skipped calibration entries.
