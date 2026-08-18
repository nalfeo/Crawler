# Handoff: velocity empty-draft repeat budget

## Date

2026-08-17

## Persona

DevOps Engineer / Velocity Engineer consult

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎. Tooling/process guard change with focused tests; no review ledger required at this tier.

## Summary

Ran the nightly velocity bottleneck loop for `nalfeo/Crawler#3024`. Fresh velocity-engineer evidence showed the top actionable bottleneck was repeat empty Copilot draft churn, with `copilot-empty-draft-repaired` dominating the most recent closed-unmerged PR cohort. Guard deny rates, apple estimate drift, current open queue aging, and merged-PR review latency were not the top bottleneck.

Landed the smallest measurable fix in `.github/scripts/pr-ready-reviewer-guard.mjs`: first eligible empty-draft repair still closes the shell and restarts Copilot, but now labels the linked issue with the repair marker. If another empty draft later links to that already-marked issue, the guard closes the shell, adds a repeat-triage label/comment to the issue, removes Copilot from the issue, and does **not** immediately reassign Copilot again.

## Bottleneck evidence

Velocity consult baseline:

- Recent merged PR lead time sample: median ~1.98h, p90 ~7.63h; review queue was not the visible long pole.
- Open PR aging at session start: only one open PR older than 4h.
- Guard telemetry aggregation: `pr-preflight` deny rate ~4.1%, `pr-review-ledger` ~3.7%, not the dominant waste source.
- Recent unmerged sample: `copilot-empty-draft-repaired` was 14 of the latest 20 unmerged PRs and 15 of the latest 30, making empty-draft repeat churn the current top actionable class.

## Fix details

- Added `EMPTY_DRAFT_REPEAT_TRIAGE_LABEL`.
- `inspectEmptyCopilotDraftRepair` now detects whether the linked issue already has an empty-draft repair/triage marker.
- First repair path adds the repair marker to the linked issue after Copilot reassignment succeeds.
- Repeat repair path closes the empty shell, labels/comments for triage, removes Copilot, and skips reassignment.
- Existing race/drift checks and rollback behavior remain in place.

## Verification

- `node --test .github/scripts/pr-ready-reviewer-guard.test.mjs` — 63/63 passing.
- `npx prettier --check .github/scripts/pr-ready-reviewer-guard.mjs .github/scripts/pr-ready-reviewer-guard.test.mjs` — passing.
- `npx eslint .github/scripts/pr-ready-reviewer-guard.mjs .github/scripts/pr-ready-reviewer-guard.test.mjs` — passing.
- `npm run verify:fast` — passing; 138 test files / 2259 tests passed plus fast integrity checks.
- Secret scan: `.github/scripts/pr-ready-reviewer-guard.mjs`, `.github/scripts/pr-ready-reviewer-guard.test.mjs` — no secrets detected.

## Before/after measurement

Before: live velocity consult found repeat empty-draft churn as the dominant recent closed-unmerged class (`copilot-empty-draft-repaired`: 14 of latest 20 unmerged PRs).

After field check: rerun `npm run velocity:scan -- --limit 100` on an authenticated GitHub runner after 24–48h or the next 50–100 closed PRs. Success is a material drop in `copilot-empty-draft-repaired` share without an increase in stuck open empty drafts or unlabeled closed-unmerged PRs.

## Refs

Refs nalfeo/Crawler#3024
