# Session Handoff: PR #3646 review comments

## Date

2026-08-27

## Persona

DevOps Engineer / PR Shepherd

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Addressed all three review findings on PR #3646. Quarantine repair now recognizes
verified replacement PRs across open, merged, and closed-unmerged lifecycles,
verifies non-merged replacement heads still descend from the quarantined head,
and remains idempotent after the merge train moves or deletes the repair branch.
The supersede notice now starts with a managed CI marker. Copilot issue restarts
remove every currently assigned Copilot actor variant before reassigning the
selected actor, preventing a same-set no-op. Completed and validated the required
independent grade. This is tooling-only behavior; deterministic node tests and
`npm run verify:fast` exercised the real scripts.

## Key Decisions Made

Merged replacement PRs are terminal ownership records and do not require their
deleted or advanced branch to retain the original head. Open and closed-unmerged
replacements remain fail-closed: their live head must be identical to or descend
from the original quarantined head.

## What's Next / Blockers

No implementation blockers remain. Release the shepherd lease after the review
threads are resolved and let CI Recovery admit the PR to the merge train.

## Retrospective

### Lessons Learned

Checking an existing replacement before validating the mutable ref is necessary
for merged-PR idempotency, but lifecycle state must determine whether ancestry
verification still applies.

### Mistakes Made

The first lifecycle fix trusted marker and base metadata without checking the
live head of non-merged replacements. The focused re-review caught this before
publication.

### Opportunities for Future Improvement

The independent-grade CLI currently refuses diffs above 200,000 characters
without offering a supported file-by-file packet mode. A deterministic large-diff
manifest mode would avoid requiring the grader to inspect the workspace directly.
