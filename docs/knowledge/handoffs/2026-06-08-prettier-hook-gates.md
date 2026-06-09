# Handoff: Prettier hook gates

## Summary

Added local Git hook enforcement for Prettier to reduce formatting churn before PR submission. The branch now auto-configures a repo-owned hooks path and enforces formatting on commit/push.

## Files touched

- `.gitattributes`
- `.githooks/pre-commit`
- `.githooks/pre-push`
- `package.json`
- `scripts/agent/setup-git-hooks.mjs`

## Verification run

- `npm run prepare`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`

## Unresolved issues

- `verify:fast` wrapper can hang in this environment; direct equivalent checks were used instead.

## Recommended next steps

- Keep `npm run format:check` as a required PR check in branch protection to pair local hooks with server-side enforcement.
- Communicate to contributors that running `npm install` (or `npm run prepare`) configures hooks automatically.
