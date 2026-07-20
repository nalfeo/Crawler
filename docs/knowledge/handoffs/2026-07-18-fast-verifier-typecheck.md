# Session Handoff: Fast verifier full-project typecheck

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact — one verifier fix plus deterministic regression coverage).

## What changed

- Replaced `verify-fast.sh`'s source-only `tsconfig.src.json` compiler gate with the
  authoritative incremental `tsconfig.json`, covering `src/**/*.ts`, `tests/**/*.ts`,
  and `scripts/**/*.ts` without changing compiler context.
- Preserved parallel TypeScript/ESLint execution and made signal cleanup explicit so
  interrupted runs terminate and reap both child processes.
- Added isolated regression fixtures that run the real verifier static phase through
  the repository's Git-Bash/WSL/Linux path and environment helpers.
- Kept the static-only test hook compatible with the production default project so
  the regression suite now exercises `TSC_PROJECT="tsconfig.json"` unless a test
  explicitly overrides it.
- Corrected step labels and output so the verifier accurately describes full-project
  typechecking, changed-file linting, changed tests, and health checks.

## Before / after

- Before, a changed test containing a narrowed-property TS2339 made
  `npm run typecheck` exit 2 while `npm run verify:fast` exited 0 and printed
  `Fast verification passed`.
- After, the same test-only error exits nonzero through the fast verifier static gate.
  Matching source-only and script-only fixtures also fail; a clean fixture containing
  all three surfaces passes.
- Warm local compiler timing was 7.603s for `tsconfig.src.json` and 9.011s for the
  authoritative `tsconfig.json`, a measured +1.408s static-gate cost.

## Verification

- `npx vitest run --project unit tests/unit/verify-fast-typecheck.test.ts --reporter=verbose`
- `npm run typecheck`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-fast-verifier-typecheck.review-ledger.json`
- `npm run verify:pr-prereqs`

## Authority and base

- Authoritative issue: #1570, open and maintainer-authored.
- Branch base: `origin/main` at `84489aa693a18831b68c024630cf268eed35bd35`.
- No game runtime or gameplay behavior changed. The `verify:fast` gate itself is
  intentionally strengthened: TypeScript coverage expands from source-only
  (`tsconfig.src.json`) to the full project (`tsconfig.json`, covering
  `src/**`, `tests/**`, and `scripts/**`).

## Follow-up

None required.
