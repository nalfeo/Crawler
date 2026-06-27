# Session Handoff: Reviewer — No Dead Parallel Path

**Date:** 2026-06-26
**Persona:** Reviewer
**Apple estimate:** 🍎 (1) · **Actual:** 🍎 (1) · **Verdict:** exact

## Summary

Fix #4 of a 4-part initiative addressing **architectural inconsistency / dead
parallel path** failures surfaced in a retrospective of past Crawler sessions.

The deterministic half of this fix already exists: the `pr-preflight` guard
(`.github/extensions/copilot-guards/guards/pr-preflight.mjs`) has `checkCrossSystemAdr`,
which warns when a diff spans 2+ architectural layers (`src/core`, `src/engine`,
`src/game`) without an ADR. That guard was **not** touched.

This change adds the missing **human-judgment** complement: a new
`### Architectural consistency` subsection in the Reviewer persona's
antagonistic-review checklist with a **No dead parallel path** item. It requires a
reviewer to demand that any change introducing an overlapping/duplicate code path
either deletes the superseded path in the same change, or lands an ADR under
`docs/knowledge/adr/` justifying the coexistence. The divergent post-process /
sprite-slicing pipelines are cited as the canonical failure. The item explicitly
notes it catches **single-layer** duplication the guard cannot see, and that
deterministic CI is unchanged (review judgment, not a CI LLM-judge).

## Files touched

- `docs/agent-os/personas/reviewer.md` — appended a new `## Antagonistic-review
checklist` section (at EOF, no existing content reflowed) containing the
  `### Architectural consistency` subsection.
- `docs/knowledge/metrics/apples/2026-06-26-reviewer-no-dead-parallel-path.json` — apple metric.
- `docs/knowledge/handoffs/2026-06-26-reviewer-no-dead-parallel-path.md` — this handoff.

## Verification

- `npm run verify:fast` — ✅ passed (typecheck + lint + unit tests).
- `npm run verify` — ✅ "Full verification passed" (typecheck, lint, format,
  dead-code, unit + coverage, integration, headless Floor 1 gate, build).

Docs-only diff, so the handoff gate auto-skips; handoff written per repo rules.

## Concurrency / merge note

A sibling sub-session is concurrently adding a different `### Solution shape`
subsection to the **same** `reviewer.md`, intended to live under the same new
`## Antagonistic-review checklist` parent. This edit is localized to the new parent

- `### Architectural consistency` subsection appended at EOF and reflows nothing
  above it. If the sibling PR merges first, expect a small rebase: keep a single
  `## Antagonistic-review checklist` header and both `###` subsections under it.

## Next steps

- None required. If both checklist PRs land, consider a follow-up that promotes the
  shared `## Antagonistic-review checklist` framing into a short index if more
  subsections accumulate.
