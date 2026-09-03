# 2026-09-01 — docs-update.yml duplicate `base:` key breaks Unit Tests after rebase

## Systems touched

ci-automation

## Summary

PR #4041 (this branch, "supply an explicit base branch for the docs-update
automation PR") added `base: main` to the two `peter-evans/create-pull-request@v7`
steps in `.github/workflows/docs-update.yml`. Independently, PR #4053 ("Fix
docs-update PR creation on workflow*run detached HEAD") landed on `main` with
the \_same* fix. When this PR's branch was fast-forwarded/merged with `main` via
`update-branch`, the merge kept both PRs' `base: main` lines in each `with:`
block, producing a duplicate YAML mapping key at line 182 (and a second
duplicate at line 224 for the retry step):

```yaml
with:
  token: ${{ secrets.CRAWLER_CI_PAT }}
  base: main          # <- from this PR's original commit
  branch: automation/docs-update
  ...
  base: main          # <- from main's #4053, survived the merge
  title: ...
```

`yaml`'s `parse()` (used by `tests/unit/docs-update-workflow.test.ts` to load
and assert on the workflow) throws `YAMLParseError: Map keys must be unique`
on duplicate keys, so **8 of the 656 unit test files failed** immediately
after `git merge origin/main` / the merge-train's `update-branch` pulled main
in. `gh pr checks` showed `Unit Tests: fail` and `ci: fail` for the freshly
merged head SHA.

## Root cause

Two independent PRs fixed the identical bug (missing `base:` input causing
`create-pull-request@v7` to hard-fail on a detached-HEAD checkout) by editing
the same lines. Git's line-based merge/rebase machinery has no semantic
understanding of YAML mapping uniqueness, so it happily kept both `base: main`
insertions as separate lines instead of recognizing them as the same edit.

## Fix

Removed the duplicate `base: main` line from both `with:` blocks (`Open docs
automation PR` and `Retry docs automation PR after branch race` steps),
keeping the version with the explanatory comment about the detached-HEAD
checkout. Verified:

- `npx vitest run tests/unit/docs-update-workflow.test.ts` — 8/8 pass.
- `npm run typecheck`, `npm run lint`, `npm run format:check` — clean.
- Confirmed via `node -e` YAML parse that each `with:` block now has exactly
  one `base: main` key.

## Lesson

When two PRs independently fix the same root cause by inserting the same
YAML/JSON key into the same block, a routine `update-branch`/merge can silently
produce a duplicate-key file that only a strict YAML/JSON parser (not GitHub's
own workflow runner, which is more lenient) will reject. `Unit Tests` failing
right after a branch update — with no code change of your own — is a strong
signal to diff the _merged_ file against both parent branches for duplicate
lines, not just to assume a flaky test.
