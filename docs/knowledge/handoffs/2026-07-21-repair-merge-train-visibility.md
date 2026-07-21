# Repair merge-train candidate-check visibility

## Date

2026-07-21

## Persona

DevOps Engineer.

## Systems touched

ci-policy

## Apples

4 apples estimated, 4 apples actual. The estimate was exact: the task required
production API diagnosis, a trust-sensitive fallback reader, deterministic
coverage, operational recovery, and full multi-model review.

## Incident and root cause

Merge Train Validation run `29797565419` successfully published trusted
`crawler-ci` App check `88538694323` for the three-PR candidate, but the
controller's paginated
`GET /commits/{mainSha}/check-runs?filter=all` lookup returned no
`merge-train-candidate` runs. The same run was present through
`GET /check-suites/80671691855/check-runs?filter=all`.

The unchanged main SHA had accumulated more than 1,600 GitHub Actions check
suites. GitHub's commit-scoped check-run index omitted the separate trusted-App
suite at that volume even though direct suite enumeration remained complete.
Writer credentials and App identity were correct (`crawler-ci`, App ID
`4106541`).

## What changed

- Candidate state resolution keeps the existing commit-scoped lookup as its fast
  path, then falls back only when exact candidate evidence is missing.
- The fallback enumerates only check suites owned by the configured trusted App,
  paginates every suite's check runs with bounded fan-out, and preserves
  `trainCheckState`'s exact App-ID plus evidence-fingerprint enforcement.
- Duplicate snapshots are merged by check-run ID, preferring terminal and then
  fresher representations so a stale commit-index snapshot cannot mask direct
  suite evidence.
- Both candidate status hydration and pre-promotion reattestation use the same
  fallback. Admission and main-health reads are unchanged.
- Fallback use logs suite/page/run counts so recurrence and API disagreement are
  observable.

## Deterministic coverage

- Commit enumeration missing a terminal trusted-App check resolves from the
  suite endpoint.
- Suite-only active evidence remains pending; cancelled evidence remains
  retryable/missing.
- A terminal same-ID suite snapshot replaces stale in-progress commit evidence.
- Multiple suites and check-run pages are fully traversed and deduplicated.
- The complete merge-train test suite and `npm run verify:fast` pass.

## Production recovery

The train was paused without changing required checks. Completed high-volume
CI-recovery router/wake runs on the unchanged main SHA were pruned while all CI,
Merge Train, and Merge Train Validation evidence was retained. Check-suite
count fell from `1669` to `971`; the commit endpoint immediately exposed 41
authentic `merge-train-candidate` runs, including the original successful
three-PR evidence. The train was re-enabled and explicitly woken.

No required check, trusted-App binding, FIFO rule, candidate validation, or
promotion proof was weakened or bypassed.

## Review harness

- Adversarial plan review: `gpt-5.4`; two alternatives considered, six concerns
  resolved, `plan_divergence: minor`.
- Code review: `claude-sonnet-4.6`; implementation categories clean.
- Multi-model review: `gpt-5.3-codex` and `gemini-3.1-pro-preview`, adjudicated by
  `gpt-5.4`; zero valid implementation concerns.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-21-repair-merge-train-visibility.review-ledger.json`.
