# Session Handoff: Raise Azure Storage Queue default visibility timeout to 900s

## Date

2026-07-02

## Persona(s) adopted

**DevOps / Infra** — the task is a single durable configuration default in the
Azure-backed sprite sidecar (`scripts/sprites/queue/**`), plus its docs, an ADR,
and unit coverage. No ECS/game-logic or rendering work, so no Producer split was
needed.

## Routing verdict

✅ right persona — a scoped infra-default change with a cost/robustness tradeoff
is squarely DevOps; the plan review still caught a latent code bug, which
confirms even "one-line" infra changes benefit from the harness.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — the core change is one named-constant default, but plan review
surfaced a real blocking bug (`fromConnectionString` dropped the env override),
so the change also threaded the override through that factory and added
connection-string test coverage; that extra work is what keeps it a genuine 2
rather than a 1.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

azure-infra, ci-policy

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-raise-queue-visibility-timeout.review-ledger.json`
Stages (2🍎 tier — plan_review required; code_review run additionally at the
coordinator's request and recorded honestly):

- plan_review ✅ — gpt-5.4 (high effort). 3 concerns, all 3 resolved (1 blocking:
  `fromConnectionString` override-drop; 2 non-blocking: ADR README stale
  index/pointer, add conn-string tests).
- code_review ✅ — claude-sonnet-4.6 code-review agent. Clean on round 1, no
  concerns.

`npm run review:ledger -- validate <path>` → ✅ valid 2-apple ledger.

## What Was Done

Raised the Azure Storage Queue default visibility timeout from **300s to 900s**
so the one-command sprite sidecar (`npm run sprites:gallery`, PR #659) processes
slow `gpt-image-1` briefs without a manual env override.

- `scripts/sprites/queue/azure-queue.ts` — `DEFAULT_VISIBILITY_TIMEOUT` 300 → 900;
  rewrote the module "Visibility timeout" JSDoc and the option JSDoc to state the
  new value and the empirical rationale (16-cell sheet ~4 min typical, up to
  ~6 min slow); added an inline rationale comment on the constant. Added an
  optional 3rd `visibilityTimeout?` parameter to `fromConnectionString` (it
  previously hard-coded the default and silently dropped the env override on the
  connection-string path).
- `scripts/sprites/queue/index.ts` — env-var doc-table row `(default: 300)` →
  `(default: 900)`; `createAssetQueue` now passes the parsed `visibilityTimeout`
  into `fromConnectionString(connStr, queueName, visibilityTimeout)` so the
  `AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT` override applies on **both** the
  connection-string and account/key construction paths.
- `tests/unit/sprites/asset-queue.test.ts` — added a `@azure/storage-queue` mock
  seam (`vi.hoisted` + `vi.mock`) and 5 tests: default 900 when unset; explicit
  option overrides; env override wins on the account/key path; default 900 on the
  conn-string path; env override wins on the conn-string path. 21/21 pass.
- `docs/knowledge/adr/0041-raise-queue-visibility-timeout-default.md` — new ADR
  (see Key Decisions). `docs/knowledge/adr/README.md` — added the 0041 by-number
  row + thematic link (plus the previously-missing 0039 row; main's 0040-floor2
  row is kept), fixed the stale "next unused" pointer (→ 0042) and the count line.
- `infra/README.md` — operator example `# AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT=300`
  → `900`.

The env override and the per-call `visibilityTimeout` option remain fully intact;
only the fallback default changed.

## Runtime / real-artifact observation

Not a game ECS system — this is the sprite **sidecar** worker/queue
(`scripts/sprites/**`), so the wired-systems guard (ADR 0039) does not apply and
there is no lab. The real-artifact observation is the **live sidecar run** the
coordinator session performed before delegating:

- **Before (300s default):** slow briefs ran past the 300s window; the message
  resurfaced mid-run, the success-path ack `deleteMessage(messageId, popReceipt)`
  failed with "The specified message does not exist", `worker.processed` stayed
  `0`, and the brief was regenerated (wasted `gpt-image-1` spend).
- **After (900s — live-validated via the env override set to the new default
  value):** running `npm run sprites:gallery` with
  `AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT=900` made the backlog productive —
  `worker.processed` climbed `0 → 1 → 2` with `failed = 0`, zero "message does
  not exist" ack failures, zero bad grids.

This change makes 900s the code default so that validated behavior is the
out-of-the-box behavior. No live service was touched by this PR.

## What's Next

- Nothing required for this fix. If `gpt-image-1` latency grows materially in the
  future, revisit the 900s heuristic (the env/option override remains the escape
  hatch) — the ADR documents the tradeoff and Azure's 7-day ceiling leaves ample
  headroom.

## Blockers

- None for this change. Note (out of scope, do NOT fix here): a pre-existing
  docs-loop blocker exists in
  `docs/knowledge/adr/2026-06-30-mob-appearance-multiplayer-variants.md` and
  several older ADRs (0034/0035/0036) are missing a `## Status` section — these
  are separate, non-blocking-to-PR docs-update-loop findings.

## Branch State

- Branch: `nalfeo-probable-parakeet`
- All tests passing: yes (`npm run verify:fast` green; full `npm run verify` green)
- PR created: pending (opened immediately after verify, auto-merge armed)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist in this session, so there is no
per-session capture to commit.

Guard telemetry captured via: none

## Test Results

- `npm run verify:fast` → ✅ (typecheck + lint of changed files + unit tests,
  21/21 in `asset-queue.test.ts`).
- `npm run verify` → ✅ (see the verify run in the session log).
- `npm run docs:check` → exit 0 (the only ADR-consistency findings are
  pre-existing "missing Status section" warnings on other ADRs; 0041 is clean).

## Key Decisions Made

- **ADR 0041, after two numbering collisions.** The delegating brief said "next
  free number is 0039", but `0039-orphaned-system-wiring-guard.md` already existed
  on main (merged PR #667, referenced by repo rule #15), so this was first
  authored as **0040**. During the pre-merge rebase, main had **also** merged its
  own ADR **0040** (`0040-floor2-family-territory-and-relationship-architecture.md`)
  alongside the 0039 guard, so this was renumbered again to **0041** — the next
  genuinely free number. The README index was corrected to add the
  previously-missing 0039 row, keep main's 0040-floor2 row, add 0041, and bump the
  pointer to 0042.
- **Raise the default rather than keep requiring the env override.** 900s gives
  ~2.5× margin over a typical run and ~1.5× over a slow run. The tradeoff:
  redelivery latency on a genuine stall grows from ~5 to ~15 min, but that is
  bounded by `MAX_DEQUEUE_ATTEMPTS = 3` (ADR 0037) and is exactly the window a
  legitimately slow run needs. Documented in ADR 0041.
- **Fix `fromConnectionString` too.** Plan review found it silently ignored the
  override; the fix threads `visibilityTimeout` through so both construction
  paths behave identically.

## Retrospective

### Lessons Learned

- Even a "one-constant" change is worth a plan review: gpt-5.4 caught that
  `fromConnectionString` hard-coded the default, so the "env override stays fully
  intact" requirement was only half-true before this change. The harness paid for
  itself.
- ADR numbering advice in a delegating brief can be stale, and the free number can
  move under you: always `ls` the ADR directory and grep the README before
  claiming the "next free" number, then re-check at rebase time. Here 0039 was
  already taken when the brief was written, and 0040 got claimed by a concurrently
  merged PR during the rebase — the ADR ended up at 0041 after two bumps.
- The `@azure/storage-queue` suite had no SDK mock. `vi.hoisted` + `vi.mock`
  hoists correctly before the static import, and asserting on a shared
  `receiveMessages` spy (returning empty items so `dequeue()` yields `null`) is a
  clean way to capture the `visibilityTimeout` the queue was constructed with,
  without a live Azure connection. The `.backend` factory tests are unaffected
  because they only read a constructor-set field and never touch the SDK client.

### Mistakes Made

- Initially trusted the brief's "next free 0039". Early signal that it was stale:
  the repo's own copilot-instructions rule #15 cites ADR 0039 as the
  orphaned-system-wiring guard. Catching that reference sooner would have saved a
  double-check.

### Opportunities for Future Improvement

- `docs/knowledge/adr/README.md` is drifting (stale count header, by-number table
  stops mid-range, several ADRs miss `## Status`). A dedicated docs session could
  backfill the index and add the missing Status sections so the ADR-consistency
  loop goes fully clean.
- `createAssetQueue` parses the env timeout with `Number(...)` and does not guard
  `NaN`/empty-string/`0` (pre-existing on the account/key path; this change only
  makes the conn-string path consistent). A future hardening pass could validate
  the env value and fall back to the default on garbage input.
