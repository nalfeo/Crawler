# Handoff: Windows Bash wrapper resolution

## Systems touched

ci-policy, devtools

## Apples

Estimated: 2. Actual: 2.

## Summary

- Added `scripts/agent/shell-resolver.ts` as the central Bash selector for repository wrappers.
- Added `scripts/agent/run-bash-wrapper.ts` so npm wrappers run through that resolver instead of ambient `bash`.
- Updated `verify:fast`, `verify`, `scope`, and shell-based `security:check` steps to use the wrapper.
- Added unit coverage for POSIX passthrough, Git Bash preference, configured WSL fallback, unusable WSL shim diagnostics, no-shell diagnostics, and package-wrapper routing.

## Files touched

- `package.json`
- `scripts/agent/run-bash-wrapper.ts`
- `scripts/agent/shell-resolver.ts`
- `tests/unit/shell-resolver.test.ts`

## Verification

- `npm exec vitest run tests/unit/shell-resolver.test.ts --project unit` (the unit project ran and passed)
- `npm exec vitest run --project unit tests/unit/shell-resolver.test.ts` (the unit project ran and passed)
- `npm run typecheck`
- `npm run lint`
- `npm run scope`
- `npm run verify:fast`
- `npm run verify:pr-prereqs` initially failed only because this handoff did not exist yet; rerun after this handoff is required before closeout.

## Unresolved issues

- None known.

## Recommended next steps

- If Windows-specific failures recur, add the exact observed Git Bash or WSL path to the resolver candidate tests before expanding the resolver.
