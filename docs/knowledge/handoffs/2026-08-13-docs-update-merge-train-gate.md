# Docs update merge-train gate

## Summary

Changed the docs-update workflow so it runs only after a successful Merge Train
push landing on `main` whose payload contains at least one non-documentation
file. Docs-only payloads now exit before dependency installation, checks, PR
creation, or report generation.

## Files touched

- `.github/workflows/docs-update.yml`
- `tests/unit/docs-update-workflow.test.ts`

## Verification run

- Prettier check passed for the changed workflow and test.
- `git diff --check` passed.
- The targeted unit test could not run because `npm ci` failed with a 404 from
  the configured npm feed for `nanoid@3.3.18`.

## Unresolved issues

- The targeted unit test remains unrun until dependencies can be restored from
  an available npm feed.

## Recommended next steps

- Run `npm run test:unit -- --run tests/unit/docs-update-workflow.test.ts` in CI
  or after the npm feed is repaired.

## Systems touched

agent-tooling
