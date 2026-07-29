# Handoff: Lightweight CI for md-only PRs

**Date:** 2026-06-30  
**Branch:** nalfeo-lightweight-ci-md-only-prs  
**Apple estimate:** 🍎 (1 apple)

## Systems touched

inventory

## Summary

Added `docs_only` scope detection to CI and guards so PRs that only touch `.md`/`.txt` files skip the full test gauntlet and run only commit-lint.

## Files Touched

- `scripts/agent/ci/detect-art-only.sh` — extended to emit `docs_only=true` when every changed file is `*.md`/`*.txt` outside `src/`
- `.github/workflows/ci.yml` — added `docs_only` output; all heavy jobs now skip when `docs_only=true`; merge-gate treats those skips as PASS
- `.github/extensions/copilot-guards/lib/pr-scope.mjs` — added `ANY_MD_TXT_RE`; any `.md`/`.txt` outside `src/` now classifies as `'docs'` (was `'code'` for paths like `.github/instructions/*.md`)
- `.github/extensions/copilot-guards/guards/pr-preflight.mjs` — extended `TRIVIAL_PATH_RE` with `.+\.md$` so the handoff guard doesn't fire on md-only sessions
- Guard tests updated accordingly (190 pass, 0 fail)

## Verification

- `npm run test:guards` → 190 tests, 0 failures
- `bash scripts/agent/ci/detect-art-only.sh` → emits `art_only` and `docs_only` correctly

## What CI Now Does for md-only PRs

| Job               | Before                | After                                  |
| ----------------- | --------------------- | -------------------------------------- |
| commit-lint       | ✅ runs               | ✅ runs (separate workflow, unchanged) |
| Types & Lint      | ✅ runs               | ⏭ skipped                             |
| Format & Labs     | ✅ runs               | ⏭ skipped                             |
| Unit Tests        | ✅ runs               | ⏭ skipped                             |
| Integration Tests | ⏭ skipped (art-only) | ⏭ skipped                             |
| Headless          | ⏭ skipped (art-only) | ⏭ skipped                             |
| E2E               | ⏭ skipped (art-only) | ⏭ skipped                             |

## Unresolved Issues

None.

## Recommended Next Steps

- Consider also skipping `ci-advisory` (dead-code + npm audit) for docs-only if it's creating noise; currently it has no `if:` condition and no `needs: [changes]`.
