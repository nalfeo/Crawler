# 2026-06-08 - Docs audit refresh

## Summary
- Performed a deep documentation/spec/instruction audit focused on reducing drift from the implemented codebase and reducing future agent mistakes.
- Updated high-traffic policy and instruction surfaces plus key gameplay/system specs to match current architecture, constraints, command conventions, and known implementation status.
- Applied additional high/medium fixes after multi-model audit passes and final adjudication.

## Files touched
- `.github/copilot-instructions.md`
- `.github/instructions/ai.instructions.md`
- `.github/instructions/core.instructions.md`
- `.github/instructions/game.instructions.md`
- `.github/instructions/labs.instructions.md`
- `.specify/memory/constitution.md`
- `.specify/specs/equipment-system.md`
- `.specify/specs/sprite-generation-pipeline.md`
- `.specify/specs/stats-skills-levels.md`
- `AGENTS.md`
- `docs/guides/contributing.md`
- `docs/guides/lab-authoring.md`
- `docs/guides/system-authoring.md`

## Verification run
- `npm run verify:fast` (pass)
- Docs checks executed directly via:
  - `tsx scripts/agent/docs/check-paths.ts`
  - `tsx scripts/agent/docs/check-adr-consistency.ts`
  - `tsx scripts/agent/docs/check-readme-commands.ts`
  - `tsx scripts/agent/docs/stale-game-design.ts`
  - `tsx scripts/agent/docs/promote-handoffs.ts`
  - `tsx scripts/agent/docs/archive-handoffs.ts`

## Unresolved issues
- Non-blocking docs warnings remain:
  - ADR file `docs/knowledge/adr/0006-drops-system-architecture.md` is missing `## Status`.
  - Informational command coverage warnings from `check-readme-commands.ts`.
  - Handoff archive dry-run informational output.

## Recommended next steps
- Add `## Status` to ADR `0006-drops-system-architecture.md` to clear the remaining ADR warning.
- Decide whether to expand README/AGENTS command listings or keep current scope and accept informational command warnings.
- Continue periodic spec drift audits when major gameplay systems or automation scripts change.
