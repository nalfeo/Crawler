# Session Handoff: Merge-train unadvanceable-strike persistence

## Date

2026-08-28

## Persona

Producer

## Systems touched

ci-policy

## Apples

2🍎 exact (tooling-only; no runtime gameplay change)

## What Was Done

Swept all 15 open PRs to explain why nothing was reaching the merge train, then
fixed the one deterministic defect the sweep exposed.

Sweep findings (read-only, no repository or GitHub state mutated):

- `MERGE_TRAIN_ENABLED=true`. The train was **not** disabled. `MERGE_QUEUE_ENABLED=false`
  is a legacy variable and does not gate Merge Train; the train gate logged
  `train-gate: gate passed` on every run.
- The train was starved behind PR #3837, sitting at queue position 1. Its
  `copilot/*` head is a restricted branch, so the train's bot token gets HTTP 403
  on every `update-branch`. `reconcile.mjs` correctly declines to dequeue such a
  PR (that would recreate the #3027 label-churn livelock) but yields the FIFO
  line, so every PR behind it was starved.
- `lifecycle no-op: evaluated:repairing` in CI Recovery logs is a lifecycle
  evaluation, not an attempted repair. Clean PRs were selecting terminal dispatch
  row `R26` (`wait-admission`), so no Copilot repair was dispatched. That is
  correct behavior, not the stall.

The actual defect: the 3-strike quarantine that exists to eject exactly this kind
of unadvanceable head never fired. Strike state has no separate storage — it is an
HTML marker (`<!-- crawler-merge-train-unadvanceable:<sha>:<strikes>:<attempts> -->`)
inside the managed merge-train status comment, and `updateStatus()` is a blind
PATCH with no read-back. Merge Train runs on push, `pull_request_target`,
`workflow_run`, a 5-minute cron, and dispatch, and several observed runs overlapped
or were cancelled. A run holding a stale read rewrote the counter back to `1`, so
across many 403 passes the marker stayed pinned at `:1:1` while the comment's
`updated_at` kept moving. Three strikes could never accumulate.

The fix adds `updateUnadvanceableStatus()` in `reconcile.mjs`: re-read the
persisted record, merge it forward, write, then re-read to confirm the write
landed, retrying up to 3 times. The merge and confirmation math moved into
`reconcile-lib.mjs` as the pure `reconcileUnadvanceableStrike()` and
`unadvanceableStrikePersisted()` so it is directly testable. Both 403 call sites
now take a `statusFactory` closure receiving the reconciled strike, so the rendered
human-readable text always matches the number actually persisted.

Observation: not applicable as a runtime artifact — this is CI automation with no
gameplay surface. Behavior is pinned by 4 new deterministic tests
(`node --test .github/scripts/merge-train/reconcile.test.mjs`, 100/100 pass, was 96).

## Key Decisions Made

- **The writer never throws.** It runs inside the queued-PR loop's 403 catch path;
  an escaping error there would abandon every remaining queued PR, which is a worse
  outcome than one extra pass before quarantine. On exhausted retries it logs and
  returns the best-known strike. A source-shape test pins this.
- **Strikes still reset on a new head SHA.** The max is only taken when the persisted
  SHA matches, so an out-of-band rebase is never penalized. The cumulative
  `UNADVANCEABLE_ATTEMPT_CEILING` remains the backstop for bots that change head SHA
  every pass.
- **The merge math lives in the pure lib, not the I/O script.** `reconcile.mjs` is an
  effectful entry point that is awkward to unit test; extracting the two pure
  functions turned "no coverage for the fix" into four real assertions.
- **No changes to `evaluateUnadvanceableStrike()`.** The strike arithmetic was always
  correct. The bug was entirely in the persistence path, and narrowing the fix to the
  write path avoided disturbing well-tested logic.

## What's Next / Blockers

- PR #3837 still needs its branch advanced out-of-band. With this fix the train will
  now quarantine it after 3 strikes instead of starving indefinitely, but the real
  unblock is a manual `git fetch origin main && git merge origin/main && git push`
  from a session with push rights to that `copilot/*` branch.
- Worth considering: a genuine durable store for strike state. An HTML marker in a
  mutable comment that several concurrent workflow runs blind-write is inherently
  racy, and this fix makes it self-correcting rather than actually safe.

## Retrospective

### Lessons Learned

- A green Merge Train workflow run proves nothing merged. `reconcile.mjs` exits `0`
  on every stall path. `No admitted PR is ready for candidate construction` with a
  non-empty queue is the real stall signature, and the PR to inspect is the **oldest**
  queued one, never the one you were asked about.
- When a counter is stuck, check the write path before re-deriving the arithmetic.
  The strike math here was correct from the start and reading it repeatedly cost
  time; the telltale was the status comment's `updated_at` advancing while the
  embedded marker stayed frozen.
- `*/5` inside a JSDoc block terminates the comment. Writing "the cron runs `*/5`"
  in a `/** */` comment produced a `SyntaxError: Unexpected identifier 'cron'` that
  surfaced only as an opaque ESM module-link failure in `node --test`.
- Merge-train scripts are plain `node --test`, not vitest. `npm test -- --run .github/scripts/...`
  silently finds no test files and looks like a pass.

### Mistakes Made

- Initially reported the merge train as "disabled" based on misleading workflow
  output, and had to be corrected. The early signal was already present and ignored:
  the run log contained an explicit `train-gate: gate passed` line. Read the gate's
  own verdict before inferring a gate state from surrounding noise, and check the
  repository variable (`MERGE_TRAIN_ENABLED`) rather than a similarly-named legacy one.
- First implementation of the writer threw on exhausted retries, inside a loop whose
  surrounding comments explicitly warn that an escaping error abandons the remaining
  queued PRs. Caught on review before commit, but it was the exact failure mode the
  code already documented.
- Almost shipped the fix with zero new tests on the grounds that the existing 96
  passed. They only covered the pure strike math, which was never broken.

### Opportunities for Future Improvement

- Replace the comment-embedded strike marker with a real durable store, or at minimum
  serialize merge-train writes so concurrent runs cannot interleave on one comment.
- The merge-train concurrency group allows overlapping/cancelled runs that each hold
  a stale view of shared comment state. Auditing which other counters are persisted
  the same way (the stalled-queue pass counter uses an identical pattern) would likely
  find sibling bugs.
- Add an alert when a queued PR's strike marker fails to advance across N consecutive
  passes. That symptom was visible in the comment for a long time and nothing noticed.
