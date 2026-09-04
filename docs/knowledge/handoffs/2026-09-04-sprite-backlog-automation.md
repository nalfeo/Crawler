# Sprite backlog automation

**Date:** 2026-09-04  
**Mode:** local  
**Persona:** Graphics Designer

## Summary

Added `npm run sprites:backlog`, a resumable local generator that selects at
most five judged briefs per run under a shared $5 judge budget. It prioritizes
currently approved sprites marked `disliked`, then generation-ready missing art,
with deterministic Floor 1 → 2 → 3 ordering. Passing runs are atomically recorded
as pending human review after each brief; `--retry <concept>` clears that hold
for a deliberate regeneration.

The placeholder audit now reads manifest shards when the gitignored aggregate
manifest is absent and includes the Floor 3 enemy pack. A corpus test also
prevents malformed committed briefs from silently falling out of future runs.

## Systems touched

sprite-pipeline, sprite-workflow

## Files touched

- `scripts/sprites/sprite-backlog.ts`, `batch-cli.ts`, `batch.ts`
- `scripts/sprites/placeholder-audit-cli.ts`
- `tests/unit/sprites/`
- `package.json`
- Four existing briefs repaired after corpus validation exposed invalid YAML or
  an inherited out-of-bounds anchor.

## Verification

- `npm run verify:fast`
- Sprite-focused unit tests: 51 passed
- `npm run sprites:backlog -- --dry-run`
- Independent post-diff Reviewer pass: no validated findings

## Generation status

- Wave count: 0
- Issues opened: 0
- Approvals / assets queued / merged art PRs: 0
- Current audit: 174 placeholder-only concepts, 2 replaceable concepts
- Current eligible queue: 36 ready; first five are active Floor 1 dislikes

The first live run is blocked by the workstation environment. Durable Azure
storage credentials are absent, `az` was not installed, and the Azure CLI MSI
installer is stuck in a privileged Windows Installer process that this session
cannot stop (`Access is denied`). The pipeline correctly refused local-only
fallback. PowerShell 7 was installed, but Azure CLI setup and authentication
must complete before generation can start.

## Recommended next step

After the pending Windows Installer transaction is cleared, install/authenticate
Azure CLI, run `npm run setup:azure:env`, then run `npm run sprites:backlog`.
Review every generated sheet before approval; use
`npm run sprites:backlog -- --retry <concept>` when a pending sheet is rejected.

## Apples

Estimated 3🍎, actual 3🍎 — 🎯 Exact. The work remained a bounded tooling
subsystem with tests and one independent post-diff review.
