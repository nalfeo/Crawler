# Handoff — 2026-07-13 — Auto-publish Copilot PRs

## Summary

Closes #1081. When GitHub Copilot creates a PR off an issue, it creates the PR in **draft** state by default. Draft PRs don't trigger the full CI review + fix pipeline, so work stalls until someone manually marks the PR ready.

Two changes were made to ensure Copilot-created PRs are published immediately and reliably:

1. **`pr-ready-reviewer-guard.yml`** — Changed the `github-token` for the `actions/github-script` step from `github.token` to `secrets.CRAWLER_CI_PAT || github.token`. The GITHUB_TOKEN in `pull_request_target` context can silently fail when calling `markPullRequestReadyForReview` on a PR created by the Copilot GitHub App; using the owner PAT (`CRAWLER_CI_PAT`) ensures the GraphQL mutation succeeds and errors surface as failures rather than silent warnings.

2. **`.github/copilot-instructions.md`** — Added an explicit rule in the Merge Policy section: *Always create PRs as ready for review — never as draft.* This instruction-level enforcement prevents agents from passing `draft: true` in the first place.

## Systems touched

ci

## Files touched

- `.github/workflows/pr-ready-reviewer-guard.yml` — Use `CRAWLER_CI_PAT || github.token` for the publish-drafts step
- `.github/copilot-instructions.md` — Add "never create draft PRs" rule to Merge Policy

## Verification

- `npm run verify:fast` — passes (no source/test changes)
- YAML syntax verified by inspection (no tooling change needed)
- The `pr-ready-reviewer-guard.yml` already triggers on `pull_request_target: [opened]` so new PRs are handled immediately; the hourly schedule catches any missed cases

## Unresolved issues

None.

## Next steps

Monitor the next few Copilot-created PRs. If any still land as drafts, check whether `CRAWLER_CI_PAT` is set in the repo's Actions secrets.
