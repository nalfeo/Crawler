# Handoff: PR Title/Description Synthesis Rule

## Systems touched

docs-tooling

## Summary

Added Rule 11 to AGENTS.md and a matching bullet to `.github/copilot-instructions.md` to prevent agents from overwriting PR titles and descriptions when handling feedback turns.

The bug: when an agent receives a secondary feedback task on an existing PR (e.g. "remove some weapons" after a "expand shop inventory" PR), it was rewriting the PR title/description to only reflect the latest change, losing the primary purpose.

The fix: explicit instruction to read the existing PR title/description via `gh pr view` before writing a new one, then synthesize a holistic title that covers all changes on the branch. The dominant feature/fix drives the title; secondary changes appear as bullet points in the description.

## Files Touched

- `AGENTS.md` — Rule 11 added
- `.github/copilot-instructions.md` — matching bullet in Critical Rules section

## Verification

No code changed; documentation/instruction only. No verify run required.

## Unresolved Issues

None.

## Recommended Next Steps

If the pattern recurs, consider promoting to a guard at the `create_pull_request` boundary (e.g. a pr-preflight check that warns if the title matches the last commit message verbatim rather than synthesizing the branch).
