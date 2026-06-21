# Session Handoff: Manual Preview Slot for Mobile/Cloud QA

## Date

2026-06-21

## Persona(s) adopted

- DevOps Engineer (workflow + Pages deployment changes)

## Routing verdict

✅ right persona — this task is entirely CI/deployment workflow orchestration.

## Apples

Estimated: 🍎 x 2
Actual: 🍎 x 2
Verdict: 🎯 Exact — narrow scope limited to Vite base-path support and one new workflow.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

- Added `preview` deploy base path in `/home/runner/work/Crawler/Crawler/vite.config.ts` (`/Crawler/preview/`).
- Added `/home/runner/work/Crawler/Crawler/.github/workflows/manual-preview.yml`.
- New workflow behavior:
  - Manual trigger (`workflow_dispatch`) accepts `preview_ref` (branch/tag/ref/SHA) and optional `pr_number`.
  - Rebuilds stable `dev/` + `beta/` from main, optional `prod/` from `production` tag, and `preview/` from `preview_ref`.
  - Deploys via `actions/upload-pages-artifact` + `actions/deploy-pages`.
  - Resolves PR automatically from preview commit when `pr_number` is not provided, then comments preview URL.
  - Documents that `/preview/` is a single overwrite-in-place slot.

## What's Next

1. Trigger `Deploy Manual Preview` from Actions with an open PR branch or SHA.
2. Confirm preview comment posting behavior against one PR with explicit `pr_number` and one without.

## Blockers

- None.

## Branch State

- Branch: `copilot/manual-testing-unable-to-publish`
- All tests passing: yes
- PR created: no

## Test Results

- `bash scripts/agent/preflight.sh` ✅
- `npm run verify:fast` ✅
- `npm run verify` ✅ (known dead-code listing remains informational in current gate output)

## Key Decisions Made

1. Kept `dev/` and `beta/` sourced from main in the manual preview workflow to preserve shared QA baselines.
2. Used a single `/preview/` slot (overwrite each run) to avoid reintroducing per-PR Pages complexity.
3. Added PR comment auto-resolution from commit→PR association, with optional explicit PR input for deterministic posting.
