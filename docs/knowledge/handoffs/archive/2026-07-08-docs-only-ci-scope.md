# Session Handoff: Docs-only CI scope

## Date

2026-07-08

## Persona

Producer (CI / docs-governance hygiene)

## Systems touched

<!-- docs-only session; no runtime systems changed -->

## Apples

2🍎 exact — small CI-scope fix across the change classifier, security-review workflow, and their tests.

## What Was Done

Adjusted docs-only CI classification so documentation/governance artifacts count as
`docs_only=true` even when the PR includes non-Markdown files under `docs/**`
(notably apple-metric JSON files). Specifically, `detect-art-only.sh` now treats
`docs/**`, `.specify/specs/**`, and `AGENTS.md` as docs-only surfaces; the scope
tests now cover docs JSON/spec/governance cases; and `security-review.yml` now
detects docs-only PRs and exits through a fast no-op instead of running the full
security scan stack. Observed: the current ADR cleanup PR now classifies as
`docs_only=true`.

## Key Decisions Made

- Broadened `docs_only` by **surface**, not by blanket file extension, so docs
  artifacts like `docs/knowledge/metrics/*.json` skip heavy CI without opening a
  hole for arbitrary root/config JSON files.
- Kept the security-review workflow present on PRs, but turned docs-only runs into
  a success-shaped no-op job instead of trying to path-filter the workflow away and
  risk branch-protection weirdness.

## What's Next / Blockers

- The current heavy CI run that started before this fix may still finish in the
  background; the next push is the one that should exhibit the minimal docs-only
  check set.

## Retrospective

### Lessons Learned

- The original docs-only optimization was too narrow because it classified by
  `*.md`/`*.txt` only; once the repo started recording docs-session metadata as
  JSON under `docs/knowledge`, those PRs silently fell back to full CI.
- For required GitHub checks, a **fast no-op** is safer than relying on path-based
  workflow suppression.

### Mistakes Made

- I initially assumed the unexpected CI load came from the spec/AGENTS edits, but
  the actual spoiler was the apple-metric JSON file under `docs/knowledge/metrics`.

### Opportunities for Future Improvement

- If more governance-only surfaces appear outside `docs/**` and `.specify/specs/**`,
  centralize the docs-only allowlist in one small helper so CI, local scope, and
  guards stay aligned.
