# Session Handoff: ADR Cleanup

## Date

2026-07-08

## Persona

Producer (docs / governance cleanup)

## Systems touched

<!-- docs-only session; no runtime systems changed -->

## Apples

4🍎 exact — large cross-doc governance cleanup across the ADR index, several ADRs,
spec docs, AGENTS guidance, and one handoff lint fix.

## What Was Done

Cleaned up the ADR corpus so it more clearly separates **architecture decisions**
from **living specs**, **live policies**, and **historical implementation notes**.
Normalized malformed ADR status blocks, removed misleading numeric headers from
date-prefixed ADRs, marked a few older records as superseded/deprecated where
appropriate, added canonical-home notes to policy/spec-heavy ADRs, refreshed the
ADR and spec indexes to point readers at the right primary documents, updated the
Spawner Battle Arena spec from stale/proposed language to its shipped role, and
fixed doc-lint blockers encountered during validation (`review-harness-policy.md`,
`AGENTS.md`, and the 2026-07-07 inventory-design-language handoff). Observed:
docs-only session, so no runtime artifact changed.

## Key Decisions Made

- Treat the ADR cleanup as **reclassification**, not archival deletion: keep
  historical records in place, but make the canonical read path explicit.
- Use **superseded/deprecated** only where the old ADR should no longer be read as
  the current contract (`0007`, `0012`, `0014`), and use top-of-file notes for
  still-relevant ADRs whose live rules/specs now live elsewhere.
- Keep sprite / spawner / Floor 2 / entity-physics detail in specs, and use the
  ADR index to steer readers there first.

## What's Next / Blockers

- `docs:check` still reports a large **informational** backlog of undocumented npm
  scripts in `README/AGENTS`; none are blocking, but a future docs pass should
  decide whether to document or intentionally suppress those commands.
- The ADR directory still contains grandfathered tactical/operational records
  (for example `0041`, `0048`, and some date-prefixed hook-up ADRs). If the team
  wants a stricter archive, the next step is an explicit archive/deprecation
  policy rather than ad hoc cleanup.

## Retrospective

### Lessons Learned

- The highest-value ADR cleanup was not deleting files; it was making the
  **canonical current-state home** obvious so future sessions stop reading every
  delta ADR as if it were the primary contract.
- `npm run docs:check` surfaced unrelated doc-health issues quickly, which made
  it a good safety net for governance cleanup even though the primary changes were
  just Markdown.

### Mistakes Made

- I initially treated the first `docs:check` failure as a one-off path typo and
  only later realized the docs pipeline would keep surfacing adjacent blockers
  (`AGENTS.md` command drift, missing retrospective subsections). The early signal
  was that the command failed again after the first fix despite the ADR edits
  themselves being coherent.

### Opportunities for Future Improvement

- Add a small deterministic ADR linter that flags **misleading numeric headers** in
  date-prefixed ADRs and missing canonical-home notes for policy/spec-heavy ADRs.
- Consider a generated ADR index, or at least a small upkeep script, so status
  changes like superseded/deprecated do not rely on hand-editing the table.
