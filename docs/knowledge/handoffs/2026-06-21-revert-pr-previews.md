# Handoff: Revert Per-PR GitHub Pages Previews

**Date:** 2026-06-21  
**Author:** Copilot (DevOps Engineer persona)  
**Branch:** copilot/fix-gh-pages-breaking-404

## Summary

Reverted all changes introduced in PR #175 (feat: per-PR GitHub Pages previews) and its
follow-up fix commit (fix: switch GH Pages deployment to actions/deploy-pages).

## What Was Reverted

| File                                       | Action                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `.github/workflows/pr-preview.yml`         | Deleted                                                                        |
| `.github/workflows/pr-preview-cleanup.yml` | Deleted                                                                        |
| `.github/workflows/deploy.yml`             | Restored to pre-PR-#175 (direct upload-pages, no gh-pages branch manipulation) |
| `.github/workflows/promote-to-prod.yml`    | Restored to pre-PR-#175 (direct upload-pages)                                  |
| `vite.config.ts`                           | Removed `BUILD_BASE_PATH` env override; back to `basePaths[deployEnv] ?? '/'`  |

## Why

The per-PR preview deploy approach was overly complex and ran into issues (GH Pages
source conflicts, 404s, race conditions between PR preview and main deploy jobs). The
decision was made to drop it entirely and keep the simpler direct-to-Pages deployment.

## State Left In

- `deploy.yml` uses `actions/upload-pages-artifact` + `actions/deploy-pages` with `environment: github-pages`
- `promote-to-prod.yml` is similarly back to direct Pages deployment
- Concurrency group is `pages` (restored)
- No gh-pages branch manipulation; Pages is served via GitHub Actions source
