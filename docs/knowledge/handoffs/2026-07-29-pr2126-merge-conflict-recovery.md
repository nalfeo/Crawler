# Handoff: PR #2126 merge-conflict recovery

## Date

2026-07-29

## Persona

DevOps Engineer

## Systems touched

ai-combat-balance, ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## What Was Done

- Recovered PR #2126 from the live `main` conflict without rewriting branch history.
- Replaced `.github/scripts/sweep-budget.test.mjs` with `origin/main`'s version so the branch no longer carries the superseded latent-backlog expectation that excluded externally-blocked PRs.
- Replaced `.github/scripts/sweep-budget.mjs` with the matching `origin/main` implementation so the branch and the adopted test semantics stay aligned (`merge-train-blocked` PRs count as latent CI demand for sweep budgeting even though CI Recovery does not dispatch to them).

## Validation

- `node --test .github/scripts/sweep-budget.test.mjs`
- `npm run verify:pr-prereqs`
- `npm run verify:fast`
- `npm ci` initially failed because `package-lock.json` contains Azure Artifacts tarball URLs unreachable in this sandbox; I temporarily rewrote those URLs to `registry.npmjs.org` for the local install, completed `npm ci`, and restored `package-lock.json` before continuing. The committed diff does not include lockfile changes.

## Next / Follow-up

- Push one consolidated repair commit so GitHub can recompute PR mergeability on the new branch head.
