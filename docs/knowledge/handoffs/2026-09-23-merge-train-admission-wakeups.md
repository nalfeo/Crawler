# Handoff — Merge-train admission completion wakeups

## Systems touched

merge-train, CI workflow triggers

## Incident and cause

- PR #4659 remained open, mergeable, blocked, and unlabeled after its admission
  checks passed. Security checks completed at 2026-09-23 00:43:40 UTC; `ci`
  completed at 01:14:06 UTC.
- Merge Train run 35803274330 logged `self-admission skipped pr=#4659 reason=ci`
  at 00:43:45 UTC. Later PR events skipped the job without a queue label.
- The default-branch workflow subscribed only to main-branch CI and candidate
  validation completions. It excluded PR-branch CI, did not subscribe to
  Security Review Loop, and also rejected PR CI at the job gate. Self-admission
  therefore depended on unrelated main events or delayed scheduled runs.
- Live configuration had the train and legacy mutation bridge enabled; the
  train lane was not transferred to Goobers. This was a trigger defect, not an
  admission-check failure or ownership switch.

## Change

- Successful same-repository PR CI and Security Review Loop completions wake
  the existing self-admission pass without requiring a queue label.
- Default-branch checkouts, live admission checks, FIFO limits, job concurrency,
  ownership gates, and promotion validation remain intact. Failed, fork, and
  unrelated PR admission completions cannot enter the reconcile queue.
- No application code or admission requirements changed.

## Validation and handoff

- Focused wakeup tests cover both possible final admission workflows, rejected
  events, trusted checkouts, and existing main/candidate wakeups.
- State, reconciliation, and workflow-gating node tests: 152 passed.
- Required verification and fresh local Ducky/independent review results are
  recorded in the implementation PR description.
- Publish a ready-for-review PR and release local ownership. The existing
  default-branch dispatcher remains available to recover the stranded queue;
  the new event subscription takes effect when this fix reaches main.
