# Handoff: GitHub Pages Multi-Tier Release Pipeline

**Date:** 2026-06-03
**Branch:** `nalfeo/github-pages-hosting`
**Status:** Ready for PR review

## What Was Done

Implemented a 4-tier release pipeline for GitHub Pages deployment:

| Tier  | URL                                         | Trigger                  | Labs |
|-------|---------------------------------------------|--------------------------|------|
| Local | `localhost:3000`                            | `npm run dev` / `lab`    | Yes  |
| Dev   | `nalfeo.github.io/Crawler/dev/`             | Auto on merge + CI pass  | Yes  |
| Beta  | `nalfeo.github.io/Crawler/beta/`            | Auto on merge + CI pass  | No   |
| Prod  | `nalfeo.github.io/Crawler/`                 | Manual promote           | No   |

## Files Changed

- `vite.config.ts` — Added `DEPLOY_ENV` / `BUILD_OUTDIR` env vars for controlling base path, output dir, and lab inclusion
- `.github/workflows/deploy.yml` — Replaced simple deploy with multi-tier build triggered by `workflow_run` after CI
- `.github/workflows/promote-to-prod.yml` — New manual workflow: moves `production` git tag and rebuilds all tiers

## Key Design Decisions

1. **`deploy-pages` (full site replace)** over `gh-pages` branch partial updates — avoids drift and stale files
2. **Build to isolated staging dirs** then combine — prevents Vite's `emptyOutDir` from wiping sibling builds
3. **`production` git tag** tracks which commit prod is built from
4. **Lab-leakage guards** verify beta/prod don't contain `lab.html`
5. **`version.json`** per tier for debugging/traceability

## Setup Required

After merge, enable GitHub Pages in repo settings:
- Source: GitHub Actions
- No need to configure a branch

## Known Considerations

- Prod starts as a placeholder until first manual promotion
- Promotion rebuilds from the tagged SHA (not artifact copy) — acceptable since lockfile + pinned Node ensure reproducibility
- If Phaser asset loading is added later, use `import.meta.env.BASE_URL` prefix for all asset paths
