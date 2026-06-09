# Handoff: Fix Agent-Merge Human-Review Misdiagnosis

## Date

2026-06-09

## Problem

Agent-merge was repeatedly giving up on PRs with the false claim of a "human review block," even though branch protection has NO human review requirement. It was not looking at actual CI errors before concluding.

Root causes identified:

1. **`ci-policy.md` listed "Require at least one approving review"** in the Branch Protection Rules section. Agents reading this policy believed human reviews were required and incorrectly mapped any merge failure to that cause.

2. **Merge Policy in `copilot-instructions.md` gave no guidance on failure diagnosis.** It only said "use `gh pr merge --auto --squash`" — no instructions on what to do when that fails, how to read CI logs, or how to distinguish real failures from spurious ones.

3. **`AGENTS.md` had no Merge Policy section at all.** Agents using AGENTS.md as their primary guide had zero merge instructions.

## Changes Made

### `docs/agent-os/policies/ci-policy.md`

- Replaced "Require at least one approving review" + "Dismiss stale approvals…" with an explicit **"No human review requirement"** bullet.

### `.github/copilot-instructions.md`

- Expanded Merge Policy to:
  - Explicitly state no human review is required
  - Provide a three-step diagnosis workflow (`gh pr checks`, `gh run list`, `gh run view --log-failed`)
  - Prohibit guessing "human review block" without explicit proof from `gh pr merge` output
  - Require fixing the actual CI failure before re-trying

### `AGENTS.md`

- Added a **Merge Policy** section (was missing entirely) with the same guidance.

## What's Next

- Monitor the next set of agent-driven PRs to confirm agents are now diagnosing CI failures correctly instead of giving up.
- If agent-merge still misbehaves after these instruction updates, inspect whether the copilot-guards extension or other tool-call interceptors need updating.

## Branch State

- Branch: `nalfeo/fix-agent-merge-diagnosis`
- Verification: docs-only change, no code affected
