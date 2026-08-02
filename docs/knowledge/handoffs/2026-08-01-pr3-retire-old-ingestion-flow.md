# Handoff: PR3 — retire old sprite ingestion flow

**Date:** 2026-08-01
**Session slug:** pr3-retire-old-ingestion-flow
**Persona:** DevOps Engineer
**Apple estimate:** 2🍎 estimated / 2🍎 actual (tooling cap — agent instructions + skill files only; no runtime game code)

## Systems touched

sprite-pipeline, sprite-workflow

## Summary

This is **PR3** of the durable-sprite-edit-persistence feature series
(PR1 = queue-commit primitive, PR2 = hourly reconciler). PR3 retires the old
`sprites:checkin` → `asset-checkin` issues → `sprites:asset-pr` ingestion flow
from the agent and skill instructions, replacing it with the correct reconciler
flow: `sprites:approve` → `assets/queue` → hourly `sprite-queue-reconciler.yml`
cron → `assets/promote → main` PR.

## Root cause being addressed

The `asset-forge` agent instructions still routed step 6 to `npm run
sprites:checkin` and step 7 to `npm run sprites:asset-pr`, even though:

- `sprites:approve` (PR1) already pushes to `assets/queue` via queue-commit
- The hourly reconciler (PR2) already opens/merges the single promote PR

This caused every asset-forge session to generate a new `asset-checkin` issue and
an `assets/checkin-*` branch, creating a queue of per-sprite PRs that the reconciler
never automatically merged (they needed a separate `sprites:asset-pr` manual
consolidation step). Parallel PRs also conflicted on `manifest.json` by construction.

## What changed

### `.github/agents/asset-forge.agent.md`
- Frontmatter description: removed "check in, batch into an art-only PR"
- Loop summary: `…approve → check-in → batch PR → wire…` → `…approve → wire…`
- Step 5 (Approve): added note that approve also durably pushes to `assets/queue`
- Step 6: replaced "Check-in → `sprites:checkin`" with "Queue lands automatically
  — reconciler cron; trigger manually via `gh workflow run sprite-queue-reconciler.yml`"
- Step 7 (Wire): renumbered, content unchanged
- Steps 8/9: renumbered (Observe, Measure)
- First action §3: removed "checkin+asset-PR" from apple estimate note
- Crawler asset facts: added explicit "Do not run `sprites:checkin` or
  `sprites:asset-pr` for new work" bullet
- Definition of done: `asset-checkin issue` → `assets/queue` language
- Final report line: "check-ins" → "art queued to `assets/queue`"
- Related section: replaced "Batch + audit skills: asset-pr + placeholder-audit"
  with "Audit skill: placeholder-audit" + "Legacy art drain: asset-pr (legacy)"

### `.github/agents/equipment-theme-forge.agent.md`
- Description of Asset Forge sibling: `art→check-in→batch-PR→wire` →
  `art→approve→queue→wire`

### `.github/skills/asset-pr/SKILL.md`
- Frontmatter: rewritten as "Legacy drain only"
- Added ⚠️ notice block at the top explaining the new normal path
- Guardrails: updated to say "For new approvals, use `sprites:approve`"
- Removed the wiring automation steps (step 7 → simplified)
- Updated `sprite-catalog.json` reference (no longer in write surface)

### `.github/skills/asset-pr/references/playbook.md`
- Added ⚠️ legacy-drain-only header block
- §Recovery: replaced `sprites:checkin` recommendation with `sprites:approve`
  (which pushes to `assets/queue`)

### `.github/extensions/workflow/extension.mjs`
- Updated 3 instances of "durable asset-checkin queue" →
  "durable sprite queue (`assets/queue` branch)"

## Verification

- `npm run verify:fast` exit code 0 (tsc/eslint warnings are pre-existing sandbox
  environment issues — incomplete `node_modules`; not caused by these text-only changes)
- No TypeScript files were modified; changes are pure markdown/agent-instruction files
  and one user-visible string in `.mjs`

## What is NOT done (operational steps requiring live credentials)

- **Drain existing `asset-checkin` backlog**: run `npm run sprites:asset-pr` once
  on a dev box to fold any remaining open `asset-checkin` issues into `assets/queue`
  (or a final batch PR). The reconciler picks up orphaned branches automatically.
- **Verify reconciler is firing**: check
  `.github/workflows/sprite-queue-reconciler.yml` run history is green and the
  `assets/promote` PR exists with `merge-train` label armed.

## Follow-ups

- `sprites:checkin` CLI and `scripts/sprites/checkin.ts` / `checkin-runtime.ts`
  can be deprecated/removed in a future cleanup once no external callers remain.
  ADR 0066 cross-referenced the retirement as PR3 scope; the cleanup is optional
  since the old commands still work (they just create redundant `asset-checkin`
  issues if called).
- `scripts/sprites/asset-pr.ts` can likewise be deprecated once the legacy drain
  is complete.
