# Handoff: PR #2200 merge-train lint recovery

**Date:** 2026-07-28  
**Session slug:** pr2200-merge-train-lint-recovery  
**Issue/PR:** nalfeo/Crawler#2200  
**Apple estimate:** 2🍎

## Systems touched

ci-policy

## What was done

- Investigated the CI-only recovery request for workflow run `30384443612` via GitHub Actions MCP.
- Confirmed the root failure was in `Lightweight Checks`: ESLint `no-undef` on `.github/scripts/merge-train/reconcile.mjs` because `EMPTY_TRAIN_INCIDENT_MARKER` was referenced without importing that local name.
- Applied the smallest behavior-preserving fix by aliasing `MERGE_TRAIN_EMPTY_INCIDENT_MARKER` from the shared markers module to the existing local name `EMPTY_TRAIN_INCIDENT_MARKER`.
- Left the rest of the PR unchanged because the aggregate `ci` and `Merge gate` failures were downstream of that lint error.

## Verification

- `npx eslint .github/scripts/merge-train/reconcile.mjs --max-warnings 0` ✅
- `node --check .github/scripts/merge-train/reconcile.mjs` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅
- Secret scan on `.github/scripts/merge-train/reconcile.mjs` ✅

## Notes

- Local dependency install required a temporary, uncommitted lockfile URL rewrite from `ms-feed-*.pkgs.visualstudio.com` tarball hosts to `registry.npmjs.org` so `npm ci --ignore-scripts` could complete in this sandbox; the original `package-lock.json` was restored before continuing.
