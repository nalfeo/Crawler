# Session Handoff: Sidecar asset-backlog resume + queue visibility-timeout incident

## Date

2026-07-02

## Persona(s) adopted

**DevOps Engineer** (operational coordinator). This session was an ops/coordination
session for the sprite-generation pipeline: start the sidecar, drain the
`asset-request` backlog, keep the live Azure-backed service safe, and route the
actual code fixes to specialist subsessions rather than editing code here.

## Routing verdict

✅ right persona — the work was operational (launch/observe/root-cause/mitigate)
plus cross-session coordination; all durable code changes were correctly routed
to specialist subsessions (generation, parser, startup, visibility-timeout) that
each shipped their own reviewed PR.

## Apples

Estimated: 🍎 x 1 <!-- declared as a routine "start the service + confirm" ops touch -->
Actual: 🍎 x 2
Verdict: 📉 Under — a live **queue visibility-timeout incident** surfaced mid-resume
(300s default marginal vs real ~4–6 min gpt-image-1 generations), which I had to
root-cause, mitigate live via a shell env override, validate against the live
pipeline, and then delegate as a durable code-default PR — on top of shepherding
four separate fix PRs to merge. That pushed it past a trivial one-command ops touch.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

sprite-workflow

## Review Harness

N/A for this session's own diff — **docs-only** (this handoff + the apple-metrics
JSON), which is ledger-exempt per the `pr-review-ledger` guard. Every code-touching
change this session drove shipped through its **own** subsession with its own
apple-scaled review harness + validated ledger:

- #659 (startup, 2🍎) — plan review + code-review loop, ledger valid.
- #662 (generation Bug A+B, 4🍎) — dual-plan synthesis + code-review loop + multi-model review, ledger valid.
- #656 (parser, 3🍎) — full harness, ledger valid.
- #670 (visibility default, delegated) — full harness, ledger valid.

## What Was Done

Original ask: **"Start the sidecar and service, process the backlog of asset
requests, confirm issues are picked up and worked."**

1. **Started the pipeline** via the one-command `npm run sprites:gallery`
   (sidecar `:11610` = `azure-blob` run-store + `azure-queue`; worker + issue
   ingester auto-start). Confirmed issues picked up and worked end-to-end.
2. **Root-caused + routed three systemic blockers** discovered during startup,
   each to a parallel autopilot subsession, and drove all PRs to squash-merge:
   - **#659** — slow (~8 min) startup → fast Azure env bootstrap (228s → 43.2s). Merged `a98ae91`.
   - **#661** — apple-metrics `hello_kitties` correction to canonical 0.4 (docs). Merged `b1225405`.
   - **#662** — generation Bug A (worker poison-loop + comment spam) + Bug B
     (bad-grid 16→8 slice mismatch, prompt-only gutters, exact-16 gate + 16-variant
     target UNCHANGED). Merged `981359d5`, ADR **0037**.
   - **#656** — parser only took a single first-line sentence, silently skipping
     39 rich multi-sentence briefs (#588–626). Relaxed parser + tests. Merged
     `440a0bf9`, ADR **0038**.
3. **Live observed resume** (user-approved): resynced worktree `--ff-only` to
   `440a0bf9`, refreshed Azure creds, relaunched `sprites:gallery`. Parser fix
   confirmed live (ingester enqueued the 39 newly-parseable briefs); Bug B (#662)
   confirmed on the real model (valid 16-cell grids).
4. **NEW incident found + fixed: marginal queue visibility timeout.**
   `scripts/sprites/queue/azure-queue.ts` `DEFAULT_VISIBILITY_TIMEOUT=300` (5 min)
   is marginal vs real gpt-image-1 16-cell generations (typical ~4 min, slow to
   ~6 min). When a run exceeds the window the pop-receipt goes stale → `ack()`
   (`deleteMessage`) fails with **"The specified message does not exist"** →
   `processed` never increments and the brief regenerates (wasted API $). Distinct
   from #662's poison loop (which bounds it safely). **Immediate live fix:** set
   `AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT=900` in the shell env before launch
   (avoids the `.env.local`-watch launcher-kill). **Validated live:** `processed`
   climbed 0→27 with acks succeeding, zero "message does not exist".
5. **Delegated the durable code-default fix** → subsession
   `c56ea798-7ba3-4c36-997c-620fa3200bd8` → **#670 MERGED** (`aca0f43b`):
   `DEFAULT_VISIBILITY_TIMEOUT` raised 300 → **900** on `main`, env override + per-call
   option intact, ADR **0041**. So a future `npm run sprites:gallery` works without
   the env override.

Live drain snapshot at handoff-write time: **processed=27, failed=6** (~82%),
worker + ingester running, ~30 briefs still on the Azure queue. Per the user's
explicit choice, the attached run is left draining while this session stays alive.

## What's Next

- **Finish/observe the drain.** ~30 briefs remain on the queue (~2–2.5h at
  ~4–6 min each). The attached run drains them while the session is alive; any
  left over persist on the Azure queue (~7 days) and will be picked up by the next
  `npm run sprites:gallery` (now with the durable 900s default from #670).
- **Prompt-iteration follow-up (generation scope).** The remaining failures are a
  **bad-grid** class (real model still occasionally renders the wrong cell count,
  e.g. "expected 16 cells, slicer produced 12/20") and a **banned-vague-adjective**
  synth-validation class (e.g. "banned vague adjective 'Cool'"). Both are bounded/
  safe by #662's Bug A net (fail once, capped at `MAX_DEQUEUE_ATTEMPTS=3`, ack-first,
  at-most-once comment). The generation subsession (`0cd44ef1-...`) offered to take
  the prompt-iteration follow-up — hand it the per-brief inventory (source: the
  at-most-once "⚠️ failed" comment on each failed GitHub issue).
- **Minor optimization:** classify the banned-vague-adjective failure as _permanent_
  (currently transient → wastes 2 extra retries before drop).
- **Route pre-existing docs finding (NOT sprite scope):**
  `docs/knowledge/adr/2026-06-30-mob-appearance-multiplayer-variants.md:60`
  references a missing `tests/unit/phaser-bridge*.test.ts`. It's already on `main`
  and lives in the `docs-update` loop (not a required PR gate), so it doesn't block
  anything — but it should be routed to the mob-appearance/phaser-bridge owner.

## Blockers

None blocking. The backlog is unblocked (all four fixes on `main`); the remaining
work is a bounded drain + an optional prompt-iteration follow-up.

## Branch State

- Branch: `nalfeo-sidecar-asset-processing` (this handoff is a docs-only commit;
  the branch is behind `main` because all code fixes shipped via subsession PRs).
- All tests passing: N/A here (docs-only). Each shipped PR was fully `npm run verify` green.
- PR created: yes — docs-only handoff PR (ledger-exempt).

## Agent-OS Telemetry

Guard telemetry captured via: none (no `files/guard-telemetry.jsonl` produced this session).

## Test Results

N/A — docs-only session diff. Live-pipeline validation (the "observe before done"
gate) was done against the running service: `/api/health` `worker.processed`
climbing 0→27 with `worker.failed` bounded and zero stale-receipt ack errors after
the 900s visibility fix.

## Key Decisions Made

- **Keep the live service paused** until the fixes merged (poison-loop cost/spam
  guardrail), then do a **user-approved observed resume**.
- **Mitigate the visibility timeout via shell env, not `.env.local`** — writing
  `.env.local` right before launch trips the vite-lab file-watch and the launcher's
  coupled sidecar+lab lifecycle kills the sidecar. Shell env avoids the mtime change.
- **Raise the durable default to 900s** (covers both typical and slow generations)
  rather than tuning gameplay/gates — no requirement weakening (rules #12/#13).
- **Stand down on the optional #662 `sleep()` abort-contract hardening** — the
  guarded window is unreachable in the current synchronous executor (verified false
  positive); regression tests preserved on a local backup branch (`ef95aef9`, unpushed).

## Retrospective

### Lessons Learned

- **Detached `npm run sprites:gallery` is unreliable on Windows here** (2 attempts:
  no log, no procs — runtime detach wrapper vs `npm.cmd` + launcher child-spawn).
  **Attached async works** (observe via `read_powershell` + `/api/health`). The cost:
  the live backlog dies on session shutdown. For a persistent drain, prefer a fresh
  launch on the 900s-default `main`, or a sidecar-only entry (`scripts/sprites/sidecar/cli.ts`).
- **Do NOT modify `.env.local` immediately before/while launching** — the mtime
  change trips vite-lab's watcher and the coupled lifecycle kills the sidecar. Set
  queue tuning (`AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT`) via **shell env** instead;
  `loadEnvLocal` does not overwrite shell-set vars.
- **The worker's per-brief events are not in the sidecar stdout stream** (that stream
  is dominated by `/api/health` HTTP logs). The authoritative per-brief failure
  source is the **at-most-once "⚠️ failed" GitHub issue comment** (#662), or
  `/api/health` `worker.lastBriefId`/`lastError` snapshots. Approximate queue depth:
  `QueueClient.getProperties().approximateMessagesCount` with the `.env.local` creds.
- **ADR numbering ground truth after this session's PRs:** 0035-scope-headless,
  0036-raise-code-review-floor, **0037**-sprite-worker-poison (#662),
  **0038**-asset-request-multi-sentence-brief (#656),
  **0041**-raise-queue-visibility-timeout-default (#670). The repo tolerates dup ADR
  numbers; the real conflict locus is always `adr/README.md`.

### Mistakes Made

- **Initially over-estimated the remaining backlog as ~6** from health snapshots;
  the actual `approximateMessagesCount` was **~30**. Early signal I missed: `processed`
  - `failed` (33) vs the ~65 total parseable briefs implied ~30 left. Lesson: query
    queue depth directly instead of inferring from processed counts.
- **Crossed-message coordination churn** with the generation sub over the optional
  `sleep()` hardening (directed (a) land it, then reversed to (c) stand down). The
  sub's synchronous-executor reasoning was right; I should have analyzed the executor
  before directing a follow-up PR.

### Opportunities for Future Improvement

- **Add a queue-depth field to `/api/health`** (`worker.queueDepth` via
  `getProperties().approximateMessagesCount`) so drain progress is observable without
  a side script.
- **A first-class sidecar-only / detached drain mode** that survives session shutdown
  on Windows would let long backlogs finish unattended (the coupled gallery launcher
  ties the worker to the vite-lab UI lifecycle).
- **Classify deterministic synth-validation rejections (banned-vague-adjective) as
  permanent** in `worker.ts` to avoid the 3× transient retry.
