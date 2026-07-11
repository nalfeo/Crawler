# Handoff — Wire SpecKit drift + context evaluator into docs-update loop (Issue #66)

**Date:** 2026-07-11
**Slug:** docs-loop-speckit-context
**Session type:** Implementation
**Apple estimate:** 🍎🍎 (actual: 🍎🍎)

## Systems touched

docs-automation, scripts

## What was done

Implements items 2, 3, and a stale-comment fix for item 1 from issue #66 ("wire
up Governor harness, SpecKit drift, PackmindHub, and branch-protection in the loops"):

### Item 1 — Governor harness (update only)
`scripts/agent/health/governor-playthroughs.ts` was already fully implemented (no
SKIP). Updated the stale "Governor harness still TODO" comment in
`scripts/agent/health/balance-regression.ts` to an actionable skip message.

### Item 2 — SpecKit spec drift detection
Created `scripts/agent/docs/check-speckit-drift.ts`:
- Scans `.specify/specs/*.md` (excluding README.md)
- Checks for required sections (## Context, ## Requirements)
- Checks `> **Status:**` is present and not a placeholder
- Verifies `**Code source-of-truth:**` path references exist on disk
- Warns if source-of-truth code was committed more recently than the spec (drift)
- Verifies backtick-quoted code paths in the spec body
- Validates explicit `ADR NNNN` cross-references

### Item 3 — Context evaluator (deterministic, LLM-free)
Created `scripts/agent/docs/check-context.ts`:
- Scans AGENTS.md, persona docs, policy docs, copilot-instructions.md
- Checks path references in backticks exist on disk
- Checks `npm run <script>` references exist in package.json (supports `-- flags`)
- Validates explicit `ADR NNNN` cross-references
- Checks persona docs for required structural sections
- Verifies routing README links to actual persona files
- Checks AGENTS.md vs copilot-instructions.md consistency (preflight script, verify commands)

### Shared utilities
Created `scripts/agent/shared/path-utils.ts` with `looksLikePath`, `existsOnDisk`,
`parentDirExists`, `pathExistsOnDisk` — shared by both new scripts.

### Workflow wiring
Added two steps to `.github/workflows/docs-update.yml` (with `continue-on-error: true`):
- "SpecKit spec drift detection" → runs check-speckit-drift.ts
- "Context evaluator (AGENTS.md / persona docs)" → runs check-context.ts

Both steps aggregate findings into the weekly tracking issue via the existing
aggregate-report mechanism.

### Item 4 — Branch-protection
Out of scope for code changes (repo admin UI action). Not implemented.

## Key design decisions

- **Deterministic, no LLM**: per AGENTS.md rule #2, all CI gates are scripts with
  exit codes. Both checks use file system + git metadata only.
- **Warnings, not errors**: both scripts surface drift as `warn` (non-blocking) so
  the loop aggregates findings without stopping on first hit. Only structural
  invariants (missing required sections) use `error`.
- **Shared utilities**: extracted `path-utils.ts` to `scripts/agent/shared/` to
  avoid copy-paste drift — this differs from the pre-existing check-paths.ts and
  check-adr-consistency.ts pattern (which each have inline copies), but the new
  pair of scripts benefits from the shared module.

## Observed behavior

Both scripts produce genuine drift findings when run (12 warnings from
check-speckit-drift, 0 from check-context), all non-blocking. Exit code 0.
Tests: 1155 pass, typecheck clean, lint clean.

## What's NOT done

- `src/labs/governor-lab/headless.ts` — the issue mentioned this as the planned
  entry point, but `governor-playthroughs.ts` directly uses `runHeadless` and is
  already fully functional. A browser-facing governor lab for interactive use could
  be added as a separate task.
- Branch protection (item 4) — repo admin UI action.
- Richer per-archetype metrics in `coverage/balance-metrics.json` — the current
  metrics (floor1WinRate, floor2WinRate, combinedWinRate, totalRuns) are functional
  for `balance-regression.ts`; adding avgDuration/avgGold/avgKills is a future
  enhancement.
