# Handoff: PR #2378 coverage report JSON repair

## Date

2026-07-30

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 exact

## Summary

Recovered the hosted coverage-comment failure on PR #2378 by updating the
advisory coverage job in `.github/workflows/ci.yml` to emit Vitest's `json`
coverage reporter in addition to the existing `json-summary` and `text`
reporters.

`davelosert/vitest-coverage-report-action@v2` was failing the run because it
could not open `coverage/coverage-final.json`; the workflow only produced
`coverage-summary.json`. Emitting the JSON reporter restores the file the action
expects without changing which tests run.

## Validation

- public Actions run page for `30563688422` showed the concrete failure:
  missing `coverage/coverage-final.json`
- `git diff --check`
- manual inspection of `.github/workflows/ci.yml` confirms the coverage step now
  includes `--coverage.reporter=json`

## Notes

- Direct GitHub Actions job-log API access returned HTTP 403 in this sandbox, so
  the concrete failure was recovered from the public run summary page instead.
- `npm run verify:fast` remains blocked locally because dependencies are not
  installed and `npm ci` fails on external package-host DNS resolution for
  `ms-feed-12.pkgs.visualstudio.com`.
- `runtime-tools-secret_scanning` returned `repository not found`; the touched
  workflow file was reviewed manually and contains no secrets.
