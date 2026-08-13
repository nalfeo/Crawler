# Handoff — 2026-07-13 — Auto-publish Copilot PRs

## Summary

Closes #1081. When GitHub Copilot creates a PR off an issue, it creates the PR in **draft** state by default. Draft PRs don't trigger the full CI review + fix pipeline, so work stalls until someone manually marks the PR ready.

Two changes were made to ensure Copilot-created PRs are published immediately and reliably:

1. **`pr-ready-reviewer-guard.yml`** — Changed the `github-token` for the `actions/github-script` step from `github.token` to `secrets.CRAWLER_CI_PAT` (no fallback). The GITHUB_TOKEN in `pull_request_target` context silently fails when calling `markPullRequestReadyForReview` on a PR created by the Copilot GitHub App; using the owner PAT (`CRAWLER_CI_PAT`) ensures the GraphQL mutation succeeds. A missing/expired PAT now fails the job (instead of silently falling back to the broken token). Any draft-publish failure is accumulated and surfaced via `core.setFailed()` after all PRs are processed.

2. **`.github/copilot-instructions.md`** — Added an explicit rule in the Merge Policy section: _Always create PRs as ready for review — never as draft._ This instruction-level enforcement prevents agents from passing `draft: true` in the first place.

## Systems touched

ci-policy

## Files touched

- `.github/workflows/pr-ready-reviewer-guard.yml` — Use `CRAWLER_CI_PAT || github.token` for the publish-drafts step
- `.github/copilot-instructions.md` — Add "never create draft PRs" rule to Merge Policy

## Verification

- `npm run verify:fast` — passes (no source/test changes)
- YAML syntax verified by inspection (no tooling change needed)
- Review ledger created and validated: `docs/knowledge/review-ledgers/2026-07-13-auto-publish-copilot-prs.review-ledger.json` (1🍎, no stages required)
- The `pr-ready-reviewer-guard.yml` already triggers on `pull_request_target: [opened]` so new PRs are handled immediately; the hourly schedule catches any missed cases

## Unresolved issues

None.

## Next steps

Monitor the next few Copilot-created PRs. If any still land as drafts, check whether `CRAWLER_CI_PAT` is set in the repo's Actions secrets.
