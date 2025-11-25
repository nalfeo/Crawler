# Session Handoff: Repair copilot-guards telemetry pipeline

## Date

2026-07-02

## Persona(s) adopted

**Toolsmith** — the work is entirely agent-OS infrastructure (guard telemetry
analyzer, extension test isolation, npm wiring, policy docs), with no gameplay
or rendering surface. Producer routing was unnecessary since the scope is a
single coherent tooling layer.

## Routing verdict

✅ right persona — Toolsmith owns the `scripts/agent` + `.github/extensions`
telemetry tooling this change touches.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — multi-layer as predicted (guard-extension test isolation +
`scripts/agent` analyzer rewrite + capture mode + per-family gating + unit tests

- docs/npm wiring), plus one pre-existing blocking ADR fix surfaced by `docs:check`.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

docs-tooling

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-guard-telemetry-repair.review-ledger.json`
Stages (3🍎 tier): plan_review ✅ · code_review ✅

- plan_review: gpt-5.4 (rubber-duck), approved_with_changes, 9 concerns all adopted.
- code_review: single-model loop (claude-sonnet-4.6), round 1 clean — traced
  quarantine, dedup order-independence, per-family gating, `summarizeGuardTelemetry`
  back-compat, `telemetryCaptureNote` exit-code safety, dispatcher temp-cwd isolation.
  `npm run review:ledger -- validate <path>` → ✅ pass (valid 3-apple ledger).

## What Was Done

Repaired the guard-telemetry measurement pipeline so we can honestly grade which
of the 11 configured guards add value. **Measurement only — no guard was pruned,
disabled, or weakened** (pruning is a downstream follow-up).

Root causes fixed:

1. **Contamination (read-side + write-side).**
   - Read-side: `scripts/agent/docs/guard-telemetry.ts` now loads the configured
     guard ids from `.github/extensions/copilot-guards/config.json` and runs one
     shared `cleanTelemetryRecord()` over **both** handoff blocks and metrics
     files. A record carrying any known test-fixture id
     (`KNOWN_TEST_FIXTURE_GUARD_IDS`: boom, ctx, ctx-a, ctx-b, edit-bad, pr-a,
     pr-b, pr-hard, pr-warn, shell-a, shell-bad) is **quarantined whole** —
     which also drops the synthetic `edit-guard-self-protection` counts that
     leaked in alongside fixtures. Unknown/typo ids are dropped per-id with a
     WARN, keeping the real session.
   - Write-side (root source): `.github/extensions/copilot-guards/tests/dispatcher.test.mjs`
     used `cwd: process.cwd()` (repo root), so the guard test suite appended
     fixture events to the real `files/guard-telemetry.jsonl`. Now `noopCtx`
     points at a per-suite `mkdtempSync` temp dir with `after()` cleanup, plus a
     regression test asserting telemetry never lands in the repo root.

2. **Durable, low-friction collection.** Added `npm run telemetry:capture -- <slug>`
   (a `--capture-session` mode) that reads `files/guard-telemetry.jsonl`, filters
   to configured ids, and writes a committed per-session summary under
   `docs/knowledge/metrics/guard-telemetry/<date>-<slug>.json`
   (schema `agent-os-guard-telemetry-capture/v1`, documented in that dir's
   README). The analyzer unions committed captures **and** legacy handoff blocks,
   de-duped by session key (metrics win). This folds telemetry into the commit
   an agent already makes, replacing the honor-system prose paste.

3. **Analyzer re-enabled.** Replaced the "defer until paste-coverage ≥ 50%" gate
   (which meant the report never ran at ~12% coverage) with **per-family evidence
   gating**: a 0-fire guard is flagged **dead (WARN)** only when its `shell`/`edit`/`pr`
   family has ≥ 10 events across ≥ 3 clean sessions; otherwise it is reported as
   low-confidence **unobserved**. The report now always runs and grades honestly.

Also fixed a **pre-existing** blocking `docs:check` failure unrelated to telemetry:
`docs/knowledge/adr/2026-06-30-mob-appearance-multiplayer-variants.md:60`
referenced `tests/unit/phaser-bridge*.test.ts` — a mid-filename glob whose
pre-glob segment isn't a real directory, so `check-adr-consistency` flagged it as
missing. Replaced with the two concrete existing files. (Per repo rule #8: fix
failures you encounter, don't label them out-of-scope.)

Wiring/docs updated to make the new path the default: `package.json`,
`AGENTS.md`, `.github/copilot-instructions.md`, `docs/knowledge/handoffs/TEMPLATE.md`,
`.github/extensions/copilot-guards/README.md`, `docs/agent-os/policies/telemetry-policy.md`,
`docs/knowledge/adr/0004-chronicle-telemetry.md` (amendment). `scripts/agent/review/pr-prereq-check.mjs`
gained a **non-blocking** nudge to run `telemetry:capture` when the artifact
exists but no capture is staged (verified it can't change the exit code).

## What's Next

- **Downstream (separate session):** with honest measurement now in place, do the
  actual dead/low-value guard pruning the original audit wanted. `pr-review-ledger`
  is already flagged as a dead candidate (0 events despite 23 pr-family events
  across ≥ 3 sessions) — but that is almost certainly under-collection (the guard
  fires on `create_pull_request`, which the current telemetry window under-samples),
  not a truly dead guard. Do **not** prune it on this signal alone; raise coverage
  first, then re-evaluate.
- **Raise coverage:** adoption of `telemetry:capture` will grow the committed
  metrics dir; after a few weeks re-run the analyzer and see the family-event
  volumes climb so shell/edit guards move out of "unobserved."

## Blockers

None. Full `npm run verify` passes except the two honor-system prereqs that this
handoff + the recorded ledger now satisfy.

## Branch State

- Branch: `nalfeo-improved-waffle`
- All tests passing: yes (2847 unit · 49 integration · 17 headless · 213 guard/ledger node tests · docs:check green)
- PR created: pending (created immediately after this handoff)

## Agent-OS Telemetry

Guard telemetry captured via: none — `files/guard-telemetry.jsonl` does not exist
in this worktree (no guards fired here into a durable artifact), so there is
nothing to capture. The capture path itself was verified end-to-end against
synthetic artifacts during development (mixed real+fixture events → only
configured events captured, fixtures ignored, idempotent rerun).

## Test Results

- `npm run verify:fast` → ✅ (typecheck + lint + 24/24 guard-telemetry unit tests)
- `npm run verify` → ✅ through build; 2847 unit, 49 integration (1 skipped), 17
  headless Floor-1 tests green. (`verify:pr-prereqs` gated only on this handoff +
  the code_review ledger stage, both now done.)
- `npm run test:guards` → ✅ 213/213 (dispatcher isolation + pr-prereq notes covered)
- `npm run docs:check` → ✅ 0 blocking; the guard-telemetry analyzer now RUNS:
  37 handoff blocks → 21 clean sessions after quarantine (16 fixture-tainted
  records dropped); `pr-preflight` deny:12/allow:11 (alive); all shell/edit guards
  correctly "unobserved," not falsely "dead."

## Key Decisions Made

- **Whole-record quarantine only on a known-fixture signature** (not blanket
  "any unknown id → drop record"). This nukes contaminated records (they always
  carry a fixture id next to the synthetic real-id counts) without silently
  discarding a legitimate session that merely has a typo'd/renamed guard id.
- **Per-family (not global) dead-guard gating.** A global evidence gate isn't
  defensible when one family (pr) carries all the volume; gating per family keeps
  the report from crying wolf on under-collected shell/edit guards.
- **Committed capture files, one per session** (mirrors `metrics/apples/`) so the
  durable path is conflict-free and rides the normal commit — chosen over an SDK
  session-end hook (the extension exposes only `onSessionStart`/`onPreToolUse`,
  so true zero-touch isn't available) and over reviving `session.log()` (policy
  already deprecates Chronicle as a hard dependency).

## Retrospective

### Lessons Learned

- The contamination had **two** vectors; ID-filtering alone (read-side) cannot
  remove synthetic counts for a _real_ guard id written by dispatcher tests — the
  write-side test-cwd fix is what actually stops new leakage, and whole-record
  quarantine is what neutralizes already-committed handoffs.
- `check-adr-consistency.ts` only understands a glob when the segment **before**
  the first glob char is a real directory (`tests/unit/*.test.ts` ✓), but a
  mid-filename glob (`tests/unit/phaser-bridge*.test.ts`) resolves its "parent"
  to a non-directory and is reported missing. Prefer directory-anchored globs or
  concrete paths in ADR references.
- `report.finish()` is typed `never` (calls `process.exit`), so lines after it in
  a mode function are intentionally unreachable — not a missing-return bug.

### Mistakes Made

- First `review:ledger stage` call failed because PowerShell single-quoted
  strings are literal — escaping the inner `"` as `\"` passed the backslashes
  through to node and broke JSON parsing. Fix: unescaped double quotes inside the
  single-quoted arg. Early signal: `--json is not valid JSON: ... position 1`.
- Initial `node --test <dir>` failed (Node treats a bare dir as a module). Use
  the `test:guards` npm script's explicit glob instead.

### Opportunities for Future Improvement

- Consider teaching `check-adr-consistency.ts` to actually expand globs (via a
  small glob match) so mid-filename patterns validate correctly, rather than
  requiring authors to avoid them.
- A lightweight CI check that fails if a _new_ handoff Agent-OS Telemetry block
  contains a non-configured guard id would catch contamination at authoring time,
  not just at aggregation.
- Once `telemetry:capture` adoption is real, revisit whether the `pr-preflight`
  guard should _require_ a capture file (currently only a non-blocking nudge).
