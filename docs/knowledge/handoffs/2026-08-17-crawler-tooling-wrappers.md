# Handoff: Crawler tooling wrappers

**Date:** 2026-08-17  
**Session slug:** crawler-tooling-wrappers  
**Apple estimate:** 3🍎 estimated, 3🍎 actual  
**Status:** Implementation complete; local validation passed before final publication steps.

## Systems touched

mcp-tooling, agent-personas, ci-policy, docs-tooling

## What changed

- Added a read-only PR cockpit project extension at `.github/extensions/pr-cockpit/` with tools:
  - `list_pr_cockpit`
  - `get_pr_cockpit`
  - `get_pr_blockers`
- Added deterministic PR cockpit helpers for:
  - GitHub URL parsing and secret redaction
  - PR label normalization using repo merge-train / CI-recovery constants
  - blocker summaries for draft, mergeability, unresolved review threads, and required checks
  - paginated check-run loading with `per_page=100`
- Extended Sweep Results Viewer with dispatch tools:
  - `dispatch_weapon_sweep`
  - `dispatch_ai_sweep`
- Sweep dispatch is intentionally branch-scoped so the tool only returns `project:sweep-results-viewer runId=<id>` when exactly one new branch-scoped workflow run can be identified. Ambiguous or not-yet-visible dispatches return a warning instead of an unsafe run id.
- Added `.github/skills/session-kickoff-closeout/SKILL.md` and indexed it in `.github/skills/README.md` plus the docs governance registry.
- Wired PR cockpit tests into `npm run test:guards` and expanded `npm run test:sweep-viewer` for the new runner tests.
- Added 3🍎 review ledger: `docs/knowledge/review-ledgers/2026-08-17-crawler-tooling-wrappers.review-ledger.json`.

## Review findings addressed

- Plan review: hardened sweep run-id correlation, documented opinionated Floor-1 starter sweep defaults, imported PR state constants from repo sources, and added governance registry entry.
- Code review round 1: fixed PR cockpit check-run pagination so required checks cannot hide past the default first page.
- Code review round 2: restricted sweep dispatch correlation to branches instead of claiming tag/SHA support.
- Independent grade: wired PR cockpit tests into `test:guards` and fixed `headRefOid` → `headSha` normalization.

## Validation

- `node --test .github/extensions/pr-cockpit/tests/*.test.mjs` ✅
- `npm run test:sweep-viewer` ✅
- `npm run check:extensions` ✅
- `npm run test:guards` ✅ after clean `npm ci` restored incomplete local package installs
- `npm run format:check` ✅
- `npm run verify:fast` ✅
- `npm run review:grade -- record ...` ✅ (also validated the ledger)

## Notes for next agents

- The sweep dispatch tools do mutate GitHub by dispatching workflows, but they do not edit repo files or game state. They use `execFile`, strict input validation, and redacted error surfaces.
- A dispatch result without `viewerReference` is intentional: do not cite a Sweep Results Viewer `runId` until exact run correlation exists.
- The PR cockpit is read-only by design. Do not add write/merge/thread-resolution actions without a separate review of CI Recovery / Merge Train ownership rules.
