# 2026-09-01 docs update loop recovery

## Summary

Fixed the Docs Update Loop failure on `workflow_run` triggers by providing an explicit `base` branch to both `create-pull-request` invocations. This keeps PR creation working when checkout is pinned to a merge-train SHA (detached HEAD).

## Systems touched

ci-policy, docs-tooling

## What changed

- added `base: main` to the **Open docs automation PR** step in `.github/workflows/docs-update.yml`;
- added `base: main` to the **Retry docs automation PR after branch race** step in `.github/workflows/docs-update.yml`;
- extended `tests/unit/docs-update-workflow.test.ts` to assert both create-pull-request steps set `with.base` to `main`.

## Verification

- `npm run test:unit -- tests/unit/docs-update-workflow.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
