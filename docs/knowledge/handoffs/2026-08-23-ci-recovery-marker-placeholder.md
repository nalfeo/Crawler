# CI recovery marker placeholder hardening

## Systems touched

ci-policy

## Summary

- Investigated CI recovery incident #3385 (PR #3356) from the referenced workflow/job/thread evidence.
- Root cause: recovery task-comment guidance used HTML-like placeholder tokens (`<post-push-head-sha>`, `<sha>`, `<one-line note>`), which GitHub comment rendering stripped, producing malformed marker guidance (`✅ Addressed in : `).
- Applied the smallest fix in `.github/scripts/ci-recovery/reconcile.mjs` by replacing marker-template placeholders with non-HTML bracket tokens (`[post-push-head-sha]`, `[sha]`, `[one-line note]`) so task comments preserve the required marker format.
- Updated the focused reconcile regression assertion to match the hardened instruction string.

## Validation

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` (pass, 181/181)
- `npm run verify:fast` (pass)

## Apples

2🍎 estimated, 2🍎 actual.
