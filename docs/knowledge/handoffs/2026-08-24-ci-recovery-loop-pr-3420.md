# Handoff: CI recovery loop investigation — PR #3420 (issue #3457)

## Systems touched

ci-policy

## Apples

- Estimated: 2🍎
- Actual: 2🍎

## Summary

Investigated incident #3457 ("CI recovery loop: PR #3420"). **No deterministic
defect** exists in the marker parser, permission grant, thread-resolution path,
or mutation sequence — the automation worked exactly as designed.

## Root cause

PR #3420 has two remaining unresolved review threads
(`PRRT_kwDOSvo2Ms6bh95I` — a missing Floor 3 R6 per-Studio level gate, and
`PRRT_kwDOSvo2Ms6bh95p` — unreachable Companion-vs-Companion combat for the
party-wipe lose condition). Both were investigated by a prior `copilot-swe-agent`
dispatch, confirmed as **real, verified-against-code findings**, and correctly
left unresolved with an explicit "substantive disagreement — escalating to a
human" reply, per the review-harness policy
(`docs/agent-os/policies/review-harness-policy.md`) and the established
precedent in `docs/knowledge/handoffs/2026-08-18-ledger-recovery-guidance.md`.

Because neither the head SHA nor the blocker set changed after that reply, the
reconciler's `progressKey` (`automationProgressKey(headSha, fingerprint)`)
stayed identical across the next dispatch. `automationStallAction()` correctly
treated this as "no progress" and — after 2 attempts — filed the loop incident,
exactly per its documented design (same as the 2026-07-31 PR #2416 and
2026-08-01 PR #2613 loop-incident handoffs, both of which also concluded "no
code defect").

## The real (small) gap

The loop-incident issue template unconditionally asked the investigating agent
to hunt for "a deterministic defect in the marker parser, permission grant,
thread-resolution path, or mutation sequence" and to "implement the fix" —
even when every remaining blocker already carries a **prior recovery reply**
(the `[Prior recovery reply (no marker posted...): ...]` hint `reconcile.mjs`
already computes per-thread). That phrasing wastes a full investigate-and-PR
cycle re-deriving "this is a legitimate escalation, not a bug" — exactly what
this session, and the 2026-07-31/2026-08-01 sessions before it, had to do by
hand.

## Fix

`loop-incident-lib.mjs`: `buildLoopIncidentBody` now detects when **every**
blocker is a `review-thread` whose trusted prior-recovery hint contains the
explicit controlled phrase `substantive disagreement — escalating to a human`
(a deterministic, already-computed signal — no new GitHub calls). Generic prior
replies such as `Blocked outside this branch` keep the default investigation
prompt because they may still be agent-recoverable. When the explicit
human-escalation signal is present, the issue body:

- States the stall looks like a pending human decision, not an automation
  defect.
- Asks the investigating agent to confirm the disagreement is genuine, use
  `✅ Not applicable` only when deterministically proven, and post the open
  decision(s) as a comment for a human — instead of assuming a bug exists and
  writing a speculative "fix" PR.
- Still allows a real PR if a genuine CI-recovery automation defect is found.

When any blocker lacks the explicit human-escalation hint (e.g. a bare
`ci-failure`, an untouched/fresh review-thread blocker, or a generic prior
diagnostic reply), the original "investigate a defect" prompt is unchanged —
this only narrows the false-positive case where automation already engaged and
correctly escalated.

Untrusted blocker summary text (e.g. the actual "Escalating to a human"
sentence) is still never embedded in the issue body — only the trusted
`[Prior recovery reply...]` hint (added by `reconcile.mjs` itself for trusted
recovery replies) is inspected structurally.

## Regression tests

Added to `loop-incident-lib.test.mjs`:

- Default "investigate a defect" prompt is used when a blocker has no prior
  recovery reply.
- Default "investigate a defect" prompt is preserved for generic prior recovery
  replies such as `Blocked outside this branch`.
- Human-decision prompt is used when every review-thread blocker carries an
  explicit substantive-disagreement escalation reply.
- Default prompt is preserved when a non-review-thread blocker (e.g.
  `ci-failure`) is also present.
- Default prompt no longer instructs agents to arm squash auto-merge; merge
  remains owned by the merge train.

## Validation

- `node --test .github/scripts/ci-recovery/loop-incident-lib.test.mjs` (22/22 pass)
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` (181/181 pass)
- `npm run test:guards` — 44 pre-existing failures, all in unrelated sprite-editor
  suites (NPC depth/hit-testing, OpenCV worker, undo/redo history); none touch
  `ci-recovery`/`loop-incident`/`reconcile`.
- `npx eslint .github/scripts/ci-recovery/loop-incident-lib.mjs .github/scripts/ci-recovery/loop-incident-lib.test.mjs` — clean.
- Secret scan: both touched files — clean.
- `.github/scripts/**` is intentionally outside `npm run format:check`'s glob
  (`src/**`, `tests/**`, `scripts/**`, `functions/**`); left one pre-existing
  unformatted line in `loop-incident-lib.mjs` untouched rather than reformatting
  unrelated code (matches the mistake documented in
  `docs/knowledge/handoffs/2026-08-15-ci-recovery-router-self-blocker.md`).

## What's next / no action needed on PR #3420 itself

PR #3420's two open threads still require a human/producer decision (the R6
per-Studio level-gate threshold, and whether to build Companion-vs-Companion
combat now or formally defer it) — this session does not resolve them, since
doing so would require making a gameplay-design call this session is not
authorized to make (repo rule #11).
