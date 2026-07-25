# Handoff: CI recovery PR #2006 plan-requirement wording detection

## Date

2026-07-25

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

- Investigated CI recovery loop incident for PR #2006 and reproduced the blocker state from workflow run `30158935542` and unresolved review thread `discussion_r3650089187`.
- Root cause was deterministic classifier under-match in `reviewThreadPlanIssueNumbers()`:
  the parser only recognized a narrow set of “missing plan” phrasings and missed
  reviewer text that says a “detailed plan [must be] posted on the issue before any code was written.”
- Because the thread was not classified as a plan-requirement blocker, `reconcile.mjs`
  never added the linked issue to `retroactivePlanIssueNumbers`, so it never posted the
  retroactive issue-side plan comment; recovery dispatches then repeated without
  actionable convergence and exhausted attempts.
- Smallest fix: broaden the `planSubject` pattern in
  `.github/scripts/ci-recovery/issue-intake-lib.mjs` to include the detailed-plan-on-issue wording.
- Added focused regressions in:
  - `.github/scripts/ci-recovery/issue-intake.test.mjs` (classifier unit case)
  - `.github/scripts/ci-recovery/reconcile.test.mjs` (live reconcile retroactive-plan post path using the incident-style wording)

## Verification

- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs` ✅ (161 pass, 0 fail)
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-25-ci-recovery-pr2006-plan-requirement-wording.review-ledger.json` ✅
- `npm run verify:fast` ⚠️ blocked in this sandbox due dependency/network resolution (`ENOTFOUND ms-feed-2.pkgs.visualstudio.com`) and missing local toolchain packages after skipped `npm ci`.

## Unresolved issues

- Could not post the requested issue plan comment directly from this session (`gh issue comment` returned GraphQL 403 in this environment); this fix instead ensures CI recovery itself posts the required retroactive plan comment when incident wording matches the reviewer thread.

## Recommended next step

- Let CI recovery rerun on affected PRs so the retroactive plan-comment mutation path can execute in live automation with PAT permissions and close the review-thread blocker deterministically.
