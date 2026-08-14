# Handoff: Centralize lore canon and provenance

## Date

2026-08-14

## Persona

DevOps Engineer

## Systems touched

agent-tooling, ci-policy, content-design, set-piece

## Apples

Estimated 3🍎, actual 3🍎.

## What Was Done

Kept `docs/knowledge/game-design/lore-bible.md` as the single canonical lore
home and added an official source register covering game-design docs, committed
handoffs, briefs, dialogue/data definitions, and relevant ADRs. Canon entries now
carry source citations, while `lore-contradictions.md` is a separate escalation
register so uncertain claims cannot be silently canonized.

Added the deterministic `check-lore-canon.ts` gate to `docs:check` and the
docs-update workflow. It fails on missing canonical sections, missing citations,
unresolved contradiction records, or contradiction markers in registered sources.
Updated the documentation-update agent, Content Designer, Set Designer/blockout,
Asset Forge/briefing, graphics, and flavor instructions to read canon and trace
provenance before authoring, and to stop/escalate conflicts.

## Hard Gate

A representative content task can locate the Lore Bible, follow a source citation,
and record a contradiction with both provenance and `Status: unresolved` rather
than choosing a source silently. The workflow gate remains deterministic and
does not infer narrative truth.

## Validation

- `npx tsx scripts/agent/docs/check-lore-canon.ts` — passed.
- `npm run docs:check` — lore and persona checks passed; existing non-blocking ADR,
  command-documentation, stale-game-design, and handoff advisories remain.
- `npx tsc --noEmit` — passed.
- `npx eslint scripts/agent/docs/check-lore-canon.ts tests/unit/lore-canon.test.ts tests/unit/docs-update-workflow.test.ts --max-warnings 0` — passed.
- `npx vitest run --project unit tests/unit/lore-canon.test.ts tests/unit/docs-update-workflow.test.ts` — 8 passed.
- `bash scripts/agent/verify-fast.sh` — passed.
- `npm run test:guards` was attempted; five unrelated tests resolve `yaml`/`esbuild`
  against the separate `Q:\src\crawler` checkout and fail there because those
  modules are unavailable. No guard assertion for this change failed.

## Follow-up

The generated `docs/knowledge/handoffs/INDEX.md` should be rebuilt by the normal
docs-update automation PR; it was intentionally not edited in this feature branch.
