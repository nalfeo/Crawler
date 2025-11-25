# Session Handoff: Quarantine contaminated guard-telemetry capture files

## Date

2026-07-02

## Persona(s) adopted

Toolsmith — this is agent-tooling: a bug fix in the guard-telemetry collection
pipeline (`scripts/agent/docs/guard-telemetry.ts`) and its tests, not gameplay
`src/` code.

## Routing verdict

✅ right persona — single-owner tooling fix, one file + its tests, no
cross-layer or gameplay concerns.

## Apples

Estimated: 🍎 x 1 <!-- declared before work began -->
Actual: 🍎 x 1 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — a well-scoped mirror of an already-designed policy
(`cleanTelemetryRecord`) onto the capture path plus tests; code review came back
clean on round 1 with no rework.

Hello kitties: 1/5 = 0.20 🎀

## Systems touched

docs-tooling

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-telemetry-capture-quarantine.review-ledger.json`
Tier: 1🍎 → stage `code_review` only.

- **code_review** (loop, clean): round 1 via the `code-review` agent on
  `gpt-5.4` (fresh eyes) over `git diff main...HEAD` — **0 concerns**, no
  significant issues found. Single clean round satisfies the loop.

`npm run review:ledger -- validate <path>` → pass (`valid 1-apple ledger`).

## What Was Done

Fixed the **capture/write** side of the guard-telemetry contamination policy so
it matches the **analysis/read** side landed in #650.

### The bug

`cleanTelemetryRecord` (read path) already quarantines a telemetry record
_whole_ when it carries any `KNOWN_TEST_FIXTURE_GUARD_IDS` id (e.g. `boom`,
`shell-bad`): if a session ran the guard test-suite, even its real-guard counts
in the same record are synthetic. But the capture path
(`buildCaptureRecord` / `captureSessionMode`) only filtered fixture ids
_per-event_ and **kept** the configured-id counts from the same contaminated
session. A guard-dev session that ran the test-suite could therefore write
synthetic real counts (e.g. `edit-guard-self-protection: 92`) into a committed
capture file under `docs/knowledge/metrics/guard-telemetry/`, which the analyzer
would then read back as clean data (the fixture ids were already stripped at
write time, so the reader couldn't tell).

### The fix (`scripts/agent/docs/guard-telemetry.ts`)

1. `GuardTelemetryCaptureRecord` gains two required fields: `quarantined:
boolean` and `fixture_guard_ids: string[]`.
2. `buildCaptureRecord` mirrors `cleanTelemetryRecord`: any known fixture id in
   the artifact sets `quarantined: true`, populates `fixture_guard_ids`, and
   **zeroes** `events` / `guards` / `tools` so synthetic counts are never
   persisted. `ignored_events` / `unexpected_guard_ids` still reflect what was
   seen (diagnostic).
3. `captureSessionMode` **refuses to write** the capture file and emits a
   `[WARN]` (non-blocking) when `record.quarantined`.
4. `loadMetricsSources` skips any on-disk record with `quarantined: true`
   (defense in depth for stray/legacy capture files; older files lacking the
   field are `undefined → falsy` and are still read as clean).
5. Header doc updated to note the `--capture-session` refusal.

### Tests

- `tests/unit/guard-telemetry.test.ts`: new `buildCaptureRecord` cases —
  whole-record quarantine (zeros counts, sets `fixture_guard_ids`), quarantine
  with no accompanying configured events, and a clean-flag case. The pre-existing
  "filters to configured ids" test was rewritten to use a non-fixture unexpected
  id (`pr-renamed`) since a fixture id (`boom`) now quarantines the whole record.
- `scripts/agent/review/pr-prereq-check.test.mjs`: new deterministic
  temp-dir tests for `telemetryCaptureNote` (null when no artifact; warns when
  artifact present but no capture staged; null once a capture file is staged).

## What's Next

Nothing required. Optional future polish: a one-time audit of any already-committed
capture files for suspiciously high real-guard counts (there are none today — the
metrics dir holds only `README.md`), since pre-fix contaminated files can't be
retroactively detected by the reader.

## Blockers

None.

## Branch State

- Branch: `nalfeo-telemetry-capture-quarantine` (off latest `origin/main`).
- All tests passing: yes — full `npm run verify` green.
- PR created: yes (opened at end of session; auto-merge intentionally **not**
  armed per the kickoff instruction).

## Agent-OS Telemetry

Guard telemetry captured via: none — `files/guard-telemetry.jsonl` was not
present in this worktree at handoff time, so there is nothing to capture.

## Test Results

- `npm run verify:fast` → green (typecheck + lint + 27 unit tests in
  `guard-telemetry.test.ts`).
- `node --test scripts/agent/review/pr-prereq-check.test.mjs` → 8/8 pass.
- `npm run verify` → exit 0 (typecheck, lint, format, guards, unit + integration
  tests, PR prerequisites at the 1🍎 ledger tier, build).
- **Live verification (observe-before-done):** ran the capture CLI against a
  seeded `files/guard-telemetry.jsonl` in two states —
  - contaminated (`boom` + `edit-determinism`): CLI printed
    `[WARN] Refusing to write a capture file … carries known test-fixture guard
id(s) (boom)` and **no** file was written to the metrics dir (before the fix
    it would have written `edit-determinism` counts);
  - clean (`edit-determinism` + `pr-preflight`): CLI wrote a valid record with
    `"quarantined": false`, `"fixture_guard_ids": []` and the correct counts.
    Both smoke artifacts were deleted afterward (git left showing only the intended
    diff).

## Key Decisions Made

- Quarantine is **whole-record**, mirroring `cleanTelemetryRecord` exactly — do
  not try to salvage the "real" ids from a contaminated session, because they are
  synthetic too.
- `captureSessionMode` **refuses to write** (rather than writing a zeroed
  quarantined file) so contaminated sessions leave no committed capture artifact
  at all; the zeroed fields in `buildCaptureRecord` + the `loadMetricsSources`
  skip are belt-and-suspenders for any record that reaches disk by another path.
- Keep `quarantined` / `fixture_guard_ids` as **required** fields on the record
  type; the only constructor is `buildCaptureRecord` and the only reader casts,
  so back-compat with older field-less files holds (`undefined` → treated clean).

## Retrospective

### Lessons Learned

- The read-path fix (#650) and the write-path fix are symmetric halves of one
  policy; the write side was the more dangerous of the two because it _persists_
  synthetic data into a committed file that the reader then trusts.
- `report.finish()` returns `never` (`process.exit`), so an early
  refuse-to-write branch needs no explicit `return` — TS correctly treats the
  code after it as unreachable, matching the existing `existsSync` early-out.

### Mistakes Made

- First commit attempt used a bash heredoc (`git commit -F - <<'EOF'`), which
  PowerShell can't parse. Switched to writing the message to a session-folder
  file and `git commit -F <file>`. Reach for `-F <file>` on Windows from the
  start.

### Opportunities for Future Improvement

- The two smoke tests of the capture CLI (contaminated → refuse; clean → write)
  could be promoted into a deterministic node test that shells out to the script
  against a temp `files/guard-telemetry.jsonl`, so the refuse-to-write runtime
  branch is guarded by CI rather than a one-off manual run.
