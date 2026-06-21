# Handoff: PR Preview Deployments on GitHub Pages

**Date:** 2026-06-21  
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** on target

## What was done

Implemented per-PR GitHub Pages preview deployments. Every PR now gets its own
live URL that updates on every push and is cleaned up when the PR closes.

## Architecture decision

The existing production deployment used artifact-based GitHub Pages
(`actions/upload-pages-artifact` + `actions/deploy-pages`). This approach
deploys a single artifact that replaces the entire site, making it impossible to
host per-PR subdirectory previews alongside production.

**Migration:** Both `deploy.yml` and `promote-to-prod.yml` were migrated to push
directly to a `gh-pages` branch using git operations. Each production deploy
preserves existing `pr-*/` subdirectories. Each PR preview deploys to
`pr-<number>/` without touching production content. Concurrent pushes are handled
by a 3-attempt rebase-and-retry loop.

## ⚠️ One-time manual step required after merging

The GitHub Pages source must be changed from **"GitHub Actions"** to
**"Deploy from branch → gh-pages → / (root)"** in:

Repository Settings → Pages → Build and deployment

This is a one-time repo settings change. After this PR is merged and this setting
is changed, the next production deploy will push the `gh-pages` branch and
everything will work.

## Files changed

- `vite.config.ts` — Added `BUILD_BASE_PATH` env override for dynamic base paths
- `.github/workflows/deploy.yml` — Migrated to gh-pages branch push
- `.github/workflows/promote-to-prod.yml` — Same migration
- `.github/workflows/pr-preview.yml` (new) — Builds dev bundle, deploys to
  `pr-<n>/`, posts/updates a sticky comment with the preview URL
- `.github/workflows/pr-preview-cleanup.yml` (new) — Cleans up on PR close +
  daily cron for orphaned previews

## Preview URL pattern

`https://nalfeo.github.io/Crawler/pr-<number>/`

## Apple metrics

- Stored in: `docs/knowledge/metrics/apples/2026-06-21-pr-preview-pages.json`
