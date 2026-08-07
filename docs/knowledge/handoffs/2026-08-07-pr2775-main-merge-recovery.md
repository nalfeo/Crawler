# Handoff: PR #2775 main-merge recovery

## Date

2026-08-07

## Persona

DevOps Engineer

## Systems touched

sprite-pipeline, sprite-workflow, ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## What Was Done

- Recovered PR #2775 from the live `main` conflict without rewriting branch history.
- Fetched and unshallowed the repository, merged `origin/main` into `assets/promote`, and resolved the only overlapping files (`package.json` and `package-lock.json`).
- Kept `origin/main`'s current `postcss`/allowlist state so the branch no longer reintroduces the already-cleared expired exception while preserving the queued art reconciliation diff.

## Validation

- GitHub Actions MCP: listed recent workflow runs for `assets/promote` and fetched failed-job logs for run `31136420234` to confirm the prior blocker was the expired `postcss` allowlist.
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- `runtime-tools-secret_scanning` on the staged merge files

## Next / Follow-up

- Push the consolidated merge-recovery commit so GitHub can recompute PR mergeability on the new branch head.
