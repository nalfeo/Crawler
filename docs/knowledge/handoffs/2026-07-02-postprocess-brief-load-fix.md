# Session Handoff: Postprocess debugger brief-load fix (500 slice-map + 404 postprocess)

## Date

2026-07-02

## Persona(s) adopted

**Producer** (default for multi-layer/ambiguous work). The change spans the
sprite-generation sidecar backend, the queue worker, and the DevTools frontend,
plus a shared durability helper — a cross-layer tooling task rather than a
single-specialist one, so the Producer owned scoping, review harness, and
integration.

## Routing verdict

✅ right persona — the fix touched three subsystems (sidecar HTTP handlers,
worker retry semantics, devtools UI) behind one root cause, which is exactly the
Producer's cross-cutting remit.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — Multi-file, cross-layer defense-in-depth extending the
existing brief-durability pattern, with a full plan-review + code-review loop.
The two real bugs surfaced in code review (transient-error-drop + Windows
confinement) added work but stayed squarely inside the 3🍎 envelope.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

sprite-pipeline

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-postprocess-brief-load-fix.review-ledger.json`
Stages (3🍎 tier): plan_review ✅ · code_review ✅ (loop, 3 rounds, clean)
`npm run review:ledger -- validate <path>` → ✅ valid 3-apple ledger.

- **plan_review** — rubber-duck (gpt-5.4), approve-with-changes, 7 concerns
  (2 BLOCKING, 4 SHOULD-FIX, 1 NIT); all 7 adopted into the plan before coding.
- **code_review** — loop to clean:
  - Round 1 (claude-sonnet-4.6): clean.
  - Round 2 (gpt-5.4): 2 real bugs — (BLOCKING) `materializeBriefFromStore`
    returning `false` on ANY exception let a transient store/fs error be
    converted by the worker into a permanent `brief-not-found` drop, losing a
    valid queued job; (SHOULD-FIX) `rel.startsWith('..')` confinement missed
    cross-drive absolute paths / over-blocked `..foo` on Windows.
  - Round 3 (gpt-5.4, high effort): both concerns resolved, no new issues.

## What Was Done

Root cause: the run's `summary.json.briefPath` pointed at a **gitignored draft
brief** (`briefs/draft/tiles/tile-corridor.yaml`, `briefs/draft/.gitignore = *`)
that a worktree checkpoint wiped and which was **never mirrored** to the run
store — so it is genuinely unrecoverable for this specific run. Two debugger
endpoints hard-failed and the frontend showed a bare error with no fallback,
even though the run's complete pre-baked artifacts survive in the store.

Fix is **defense-in-depth** across three layers plus a shared helper:

1. **Prevention (mirror-on-generate)** — every worker-produced run's brief is
   now mirrored to the store (path-level, idempotent), so a future wiped draft
   is recoverable. `POST /api/workflow/generate` and the worker's brief-path job
   both materialize-then-mirror best-effort.
2. **Recovery (materialize-on-read)** — slice-map and `POST /api/postprocess`
   attempt to restore a wiped-but-mirrored brief from the store before loading.
3. **Graceful degradation** — slice-map now passes `{ projectRoot }` to
   `loadBrief` (latent bug fix) and, if the brief still can't load, degrades to a
   brief-less slice map and returns **200** with `emptyCellsApplied:false`
   instead of 500. The frontend, in degraded mode, falls back to index-keyed
   stored raw cells, suppresses the selected-cell highlight/reselect, and shows
   an "approximate slicing" note; on live-postprocess failure it renders the
   pre-baked steps via a stale-guarded `renderPrebakedSteps` closure and caches
   the terminal failure so rerenders don't re-hit the endpoint.

**Refactor** — extracted `toRepoRelativePath` / `mirrorBriefToStore` /
`materializeBriefFromStore` into new `scripts/sprites/brief-durability.ts`
(fs + store I/O; kept out of the deliberately-pure `workflow-state.ts`) so the
worker can reuse them and they get direct unit tests.

**Two code-review bug fixes:**

- **Throw-on-transient contract** — `materializeBriefFromStore` now returns
  `true` (present/recovered), `false` ONLY for a definite miss (not
  repo-confined OR `store.has() === false`), and **throws** on any store/fs
  error. The worker retries a thrown transient (plain `Error`, not permanent)
  up to the dequeue cap instead of permanently dropping the job; a `false`
  still becomes a permanent `BriefNotFoundError` drop. All 5 sidecar read call
  sites route through a best-effort `tryMaterialiseBrief` closure so a dev-tool
  read never 500s and never loses data on a transient blip.
- **Cross-platform confinement** — new exported `isRepoConfined(rel)` rejects
  `..`, `../…`, and BOTH `path.win32`/`path.posix` absolute paths (deterministic
  on any CI OS), replacing the old `rel.startsWith('..')` check in both durability
  helpers. Allows legitimate `..foo` children (fixes the old over-block).

## Runtime / real-artifact observation

N/A — game runtime. This is sprite-generation **sidecar/DevTools tooling**, not a
game ECS `*System`, so ADR-0039 wired-systems / lab rules do not apply.

Observed the **real DevTools postprocess endpoints** deterministically:

- **Before (pre-fix HEAD, via `git show` + reproduction):** slice-map →
  `500 brief-load-failed`; `POST /api/postprocess` →
  `404 briefPath does not exist in repo`; store
  `has(workflowBriefKey(...)) === false`.
- **After:** slice-map returns **200** in degraded mode
  (`emptyCellsApplied:false`, all cells non-empty) and the frontend renders the
  pre-baked pipeline instead of a bare error; a mirrored-but-wiped brief is
  recovered on read (200, `emptyCellsApplied:true`). Encoded as deterministic
  route + helper regression tests (below) rather than a one-off manual run.

## What's Next

- Merge this PR (`gh pr merge --auto --squash`).
- Optional follow-up (out of scope here): a one-shot backfill that walks existing
  run summaries and mirrors any still-present-on-disk briefs into the store, so
  historical runs gain the same durability the new generate/worker path grants
  going forward.

## Blockers

None.

## Branch State

- Branch: `nalfeo-curly-goggles`
- All tests passing: yes (`npm run verify` green except the expected
  handoff-missing PR-prereq, resolved by this file)
- PR created: pending (created immediately after this handoff)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session, so there is nothing to
capture.

Guard telemetry captured via: none

## Test Results

- `npm run verify:fast` → pass (129 tests).
- `npm run verify` → all steps green (typecheck, lint, format, guards, unit +
  integration, build; headless Floor-1 gate correctly deferred to CI). The only
  failing step was `verify:pr-prereqs`, solely because this handoff file did not
  yet exist; the `pr-review-ledger` prereq validated ✅ inline.
- Targeted regression suites: 119 pass across `brief-durability.test.ts`,
  `worker.test.ts`, `sidecar-server.test.ts`.

## Key Decisions Made

- **Broad scope (user-chosen):** make the debugger resilient (recovery + graceful
  degradation) AND add mirror-on-generate prevention — defense-in-depth — rather
  than only patching this one run.
- **Extract durability helpers into their own module** (not `workflow-state.ts`,
  which is intentionally pure) so both server and worker share them and they are
  directly unit-testable.
- **Throw-on-transient over swallow-and-return-false** for
  `materializeBriefFromStore`: correctness (never permanently drop a valid job on
  a network blip) beats a simpler always-boolean contract. Sidecar reads opt back
  into best-effort via `tryMaterialiseBrief`.
- **Did NOT refactor the inline confinement guards** (server.ts slice-map /
  loadRunBrief / `safeJoin` / `resolveRepoPath`): they already include
  `|| path.isAbsolute(rel)`, so they have no cross-drive under-block — only a
  harmless `..foo` over-block — and they additionally reject the repo-root empty
  string. Touching shared path-security helpers to fix a non-bug is scope creep +
  risk; round-3 reviewer concurred.

## Retrospective

### Lessons Learned

- A boolean helper that swallows exceptions is dangerous when a **caller maps
  `false` to a permanent/terminal outcome**. The worker treated `false` as
  "brief definitely missing → permanent drop", so a transient store error
  masqueraded as a permanent one. When a return value crosses into
  retry/permanence logic, model transient vs. definite-miss explicitly (throw vs.
  return) instead of collapsing both into `false`.
- Windows path confinement must check **both** `path.win32.isAbsolute` and
  `path.posix.isAbsolute` to stay deterministic across CI OSes; `path.isAbsolute`
  alone is platform-dependent and `startsWith('..')` misses absolute escapes.
- Worker status events have an inconsistent shape: the non-give-up transient path
  emits `{ type:'error' }` with **no** `dropped` field (undefined), while the
  give-up path sets `dropped`. Assert `!s.dropped`, not `s.dropped === false`.
- `defaultPaletteLoader(projectRoot)` throws if the palette is missing and a
  brief needs ≥2 references — so a slice-map "degrade" test must plant the palette
  ONLY under the temp repo root to prove the `{ projectRoot }` fix actually bites.

### Mistakes Made

- First worker regression test asserted `s.dropped === false`; it failed because
  the transient path leaves `dropped` undefined. Early signal: the existing
  test/worker convention at worker.ts L278 already used `!s.dropped` — should have
  matched the established pattern first.
- Initially tracked only 2 `materializeBriefFromStore` call sites from an earlier
  round; on applying the fix I found **5** in server.ts. Enumerate every call site
  before changing a shared helper's contract, not after.

### Opportunities for Future Improvement

- A historical-run brief backfill (see What's Next) would close the durability gap
  for runs generated before this change.
- Consider consolidating the four inline confinement guards and `isRepoConfined`
  into one audited path-security helper in a future dedicated pass (deliberately
  deferred here to avoid touching security-sensitive shared code out of scope).
