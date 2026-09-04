# 2026-09-04 Goobers intake stdin EAGAIN

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended** — a live, reproducing production outage in the
  post-cutover intake path, with a deterministic root cause.
- Apple estimate: **2** (tooling-only; workflow wiring + selector hardening +
  regression tests).

## Summary

Post-cutover Goobers intake was failing before it could claim anything. Runs
`33925493716` (issue #4252) and `33926202682` (issue #4253) both died in
`Resolve Goobers recovery target` with:

```
intake-selection: could not parse issue JSON from '-': EAGAIN: resource temporarily unavailable, read
```

and the failure handler then reported that _"the claimed issue number could not
be recovered ... remove the stale goobers/status:in-review label manually"_.

Two independent defects, both fixed:

### 1. The selector was fed by a pipe, and a synchronous read of a non-blocking pipe fails

`goobers-run.yml` piped `gh issue view ... | node intake-selection.mjs --issue -`,
and the CLI read stdin with `fs.readFileSync(0, 'utf8')` — a **single-shot**
read. When the runner hands the process a pipe carrying `O_NONBLOCK`, that read
raises `EAGAIN` the instant the writer has not yet produced the next bytes.
`EAGAIN` means "wait", not "this failed", but a single-shot read has no way to
wait, so a transient scheduling detail killed the whole run.

- **Primary fix (removes the failure class):** both call sites now hand the
  payload over as a **file** — `decide_issue()` captures `gh issue view` into
  `${RUNNER_TEMP}/goobers-intake-issue-<n>.json`, and the run-start race guard
  materializes `$issue_json` before selecting. No pipe, no `EAGAIN`.
- **Defense in depth:** `readAllSync()` replaces `readFileSync(0)` and loops
  through `EAGAIN` with a bounded (30s) deadline, so `--issue -` is safe for any
  future caller. Read failures are now reported separately from parse failures,
  and the read error names the file-path remediation.

### 2. The claimed issue number was recorded only _after_ every fallible lookup

Both failing runs were `issues` events that **named their target in the payload**,
yet `GOOBERS_RECOVERY_ISSUE` was written to `GITHUB_ENV` only at the very end of
the resolve step. Any earlier failure therefore produced an unattributable run:
the disposition handler could not tell which issue to restore, so it hard-failed
with a manual-cleanup error on top of the real failure.

- `persist_recovery_issue()` now records the target **before** the first
  fallible lookup, and again at each sweep selection point. Falling through to
  the sweep clears it (`persist_recovery_issue ""`), so the handler never
  releases a claim that was never made.
- The disposition handler no longer cries wolf: when there is **no run journal**,
  Goobers never started, so the gaggle's `query-backlog` claim never ran and no
  `goobers/status:in-review` label can exist — it now emits a notice and exits 0
  instead of burying the real failure under a false stale-claim error.
- All three claim releases go through one `release_claim()` helper that names
  the manual remediation command if the release itself fails.

## Observation (before / after, real shell)

The resolve step was extracted from the YAML and executed against a stub `gh`,
with the PR-cross-reference lookup forced to fail — the same shape as the
production failure:

| Workflow               | `GITHUB_ENV` after the pre-run failure |
| ---------------------- | -------------------------------------- |
| `origin/main` (before) | _(empty)_ → issue number unrecoverable |
| this branch (after)    | `GOOBERS_RECOVERY_ISSUE=4252`          |

Happy path on this branch (file-backed selector, real `gh` stub):
`Issue event selected issue #4252 (cohort: approved)` → exit 0.

## Production cleanup

Verified, then deliberately did nothing:

- `#4252` and `#4253` are both **CLOSED**, carry only `merge-train-stall-watch`,
  and have **no** `goobers/status:in-review` label and no assignees.
- The only open `goobers/status:in-review` issue repo-wide is `#3541`
  (Floor 3 Slice 16), unrelated to either run — left untouched.

This matches the code path: the in-review label is applied by the gaggle's
`query-backlog` task, which never ran in either failure. The handler's
"may leave stale labels" error was itself the false alarm now fixed above.

## Regression coverage

`.github/scripts/goobers/intake-selection.test.mjs` (node `test:guards`):

- `readAllSync` waits through `EAGAIN` — and the same scripted sequence is
  asserted to throw under a single-shot read, i.e. the test would have caught
  the incident.
- `readAllSync` reassembles a chunk-split payload; times out with an actionable
  message rather than hanging.
- The CLI produces identical output from a real stdin pipe and from a file path.
- The workflow must never reintroduce `--issue -`; both selector call sites must
  read a file.

`tests/unit/goobers-run-workflow.test.ts` (vitest unit):

- The explicitly named issue is persisted before `find_open_goobers_pr` and
  before `decide_issue` can fail; sweep selections persist too; fall-through
  clears the attribution.
- A failure before Goobers starts leaves no stale claim, and the no-journal
  branch precedes the unrecoverable-issue error.

## Files touched

- `.github/scripts/goobers/intake-selection.mjs`
- `.github/scripts/goobers/intake-selection.test.mjs`
- `.github/workflows/goobers-run.yml`
- `tests/unit/goobers-run-workflow.test.ts`

## Verification

- `npm run test:guards` — 2872 pass, 0 fail
- `npm run verify:fast` — green
- `bash -n` over all 18 `run:` scripts in `goobers-run.yml`

## Follow-ups / production verification plan

1. After merge, dispatch `gh workflow run goobers-run.yml -f issue_number=<n>`
   against a known-eligible issue and confirm `Resolve Goobers recovery target`
   completes (no `intake-selection:` error).
2. Watch the next hourly `37 * * * *` sweep for a clean cohort selection.
3. If a Goobers run does fail pre-claim, confirm the log now shows either
   `Restored retry eligibility` (with the issue number) or the new
   `no goobers/status:in-review label was created by this run` notice — never
   the manual-cleanup error.
