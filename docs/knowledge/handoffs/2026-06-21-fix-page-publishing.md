# Handoff: Fix Page Publishing (auto-configure Pages source)

**Date:** 2026-06-21
**Apple estimate:** 🍎 | **Actual:** 🍎 | **Verdict:** on target

## Problem

PR #175 migrated GitHub Pages from artifact-based (`actions/deploy-pages`) to
branch-based (`git push → gh-pages`). The migration required a one-time manual
repo settings change (Pages source → "Deploy from branch → gh-pages → /"), which
was noted in the handoff but not enforced in code. If the setting is ever reset,
or a collaborator forks the repo, page publishing silently stops updating.

## What was done

Added a self-healing "Ensure GitHub Pages source" step to both deploy workflows:

- **`.github/workflows/deploy.yml`** — added `pages: write` permission + step
  after the gh-pages push that calls `PUT /repos/{owner}/{repo}/pages` to
  configure `source.branch=gh-pages, source.path=/`.
- **`.github/workflows/promote-to-prod.yml`** — same additions.

The step is non-fatal (`|| echo "::notice::..."`) so a permissions failure or
already-correct config never blocks the deploy. On success it logs confirmation;
on failure it logs a notice.

## Why it works

`GITHUB_TOKEN` with `pages: write` is explicitly documented by GitHub as
sufficient to update the Pages source branch. The step is idempotent — calling
it when the source is already correct returns 200/204 and the notice message
fires instead of an error.

## Files changed

- `.github/workflows/deploy.yml` — added `pages: write`, new step
- `.github/workflows/promote-to-prod.yml` — same
- `docs/knowledge/handoffs/2026-06-21-fix-page-publishing.md` — this file

## Apple metrics

- Stored in: `docs/knowledge/metrics/apples/2026-06-21-fix-page-publishing.json`
