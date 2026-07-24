# Session Handoff: Durable approved/edited sprite persistence — PR1 (queue-commit primitive)

## Date

2026-07-23

## Persona

DevOps Engineer (Producer-routed).

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

4🍎 estimated, 5🍎 actual (📈 over — 7 review-driven fixes across 8 review rounds; see
`docs/knowledge/metrics/apples/2026-07-24-sprite-queue-commit-pr1.json`). NOTE: PR1 as
committed (shipped-game-data strays excluded) is arguably asset-pipeline/canvas/devtools
tooling-only (≤3🍎 cap), but the full 4–5🍎 harness was run and recorded to be safe — surfaced
to the maintainer at the pre-PR pause.

## What Was Done

PR1 of the 3-PR "durable sprite-edit persistence" feature. Architecture (adversarial-plan-review
accepted): **manifest = sole authority, git = the queue**; approved/edited assets are pushed to a
long-lived remote `assets/queue` git branch that is unclobberable across sessions/worktrees/processes.

PR1 scope = the queue-commit primitive + wiring it into approve / editor-saves / revert, plus 7
review-driven fixes:

- **queue-commit primitive** (`scripts/sprites/queue-commit.ts` + `-runtime.ts` + `-cli.ts`): a
  throwaway-worktree mechanism that fetches the `assets/queue` tip, unions the approved art surface
  onto it via `copyArtSurface` (semantic merge — no hand-rolled commit-tree re-parenting), commits
  under a reused `makeCheckinFileLock` cross-process lock, and pushes the new commit with a
  **plain fast-forward-only push** (NOT `--force-with-lease`): a concurrent advance makes it a
  non-fast-forward, git rejects it, and the bounded retry re-fetches + re-unions against the new
  tip (the plain push can never overwrite a concurrent update). `ASSET_SURFACE_PATHS` allowlist
  bounds what the union touches.
- **wiring**: approve (`src/devtools-main.ts` `doApprove`, sidecar `server.ts`, `approve-cli.ts`),
  editor saves (`.github/extensions/sprite-editor/extension.mjs`), and revert re-queue.
- **FIX 1** (round-3 F-C): CSRF origin guard added to the canonical
  `scripts/canvas-harness/canvas-harness.mjs` and byte-synced to all 5 vendored copies via
  `node scripts/canvas-harness/sync.mjs` (editing a vendored copy alone fails the CI-blocking
  `harness-drift.test.mjs`). New `canvas-harness.test.mjs`.
- **FIX 2** (`status:'ok'` spread-order clobber), **FIX 3** (stale-swallow), **FIX 4** (approve
  surfaces queueCommit failure to the UI — `sprite-approval-api.ts` `ApproveResponse.queueCommit`),
  **FIX 6** (revert double-guard surfaces a failed durable push after a mid-reload sprite switch —
  `renderer.mjs` post-`loadImage` guard), **FIX 7** (`doApprove` approveTarget capture).

**Observed (real artifact, deterministic):** queue-commit + approve/revert wiring is exercised by
the devtools approval path and the sidecar server routes; validated via `tests/unit/sprites/
queue-commit.test.ts` (491 lines) and `sidecar-server.test.ts` against the real runtime modules,
and the sprite-editor canvas via Playwright `renderer.test.mjs` (29/29, incl. the FIX 6
mid-reload-switch regression). PR1 is asset-pipeline/dev-tooling only — no `src/core|engine|game`
runtime or shipped game-data change (manifest/PNG/catalog edits in the tree are excluded strays).

## Key Decisions Made

- **manifest = sole authority, git = the queue** (over the original committed-sidecar design —
  adversarial plan review returned `major_fork`, 15 findings). Single long-lived `assets/queue`
  branch instead of per-asset branches.
- **Union-onto-refetched-tip via throwaway worktree + `copyArtSurface`** instead of hand-rolled
  commit-tree re-parenting (the confirming review flagged the re-parent approach as clobbering a
  concurrent writer's whole-manifest snapshot). Gets a semantic merge for free.
- **`ListOptions.authoritative` escape hatch** for destructive routes (from the sibling SWR PR
  #1805, already merged) — not re-touched here.
- **Finding 5 (concurrent same-repo different-asset manifest RMW race) DEFERRED**: pre-existing
  non-atomic read-modify-write, out of PR1 scope → dedicated locking-hardening follow-up.
- **F2 (whole-asset last-writer-wins) & R2-2 (old `/checkin` path) DEFERRED to PR3** (unify +
  retire the asset-checkin issue flow).

## What's Next / Blockers

- **PR2 (maintainer-requested):** hourly cron-job workflow that reconciles `assets/queue` → `main`
  (the durable branch has to land in main on a cadence). This is the local-CLI-as-cron ask.
- **PR3:** retire the `sprites:asset-pr` union + asset-checkin issue flow; fold `/checkin` old path.
- **Finding 5 follow-up:** manifest RMW locking hardening.
- **Paused sibling thread:** native-resolution sprite assets (stray
  `docs/knowledge/adr/2026-07-22-native-resolution-sprite-assets.md` + regenerated art in the tree)
  — separate 5🍎 task, see the current session plan.
- No blockers on PR1 itself; ledger valid, tests green.

## Retrospective

### Lessons Learned

- **`git diff <merge-base> -- <files>` is the only correct review diff here**, not
  `git diff origin/main` — the branch's merge-base (`f3521f30`) predates unrelated main commits, so
  diffing against `origin/main` conflates them and produces phantom "F-F/F-G" findings (round 3 —
  both were stale-base diff artifacts, correctly dismissed).
- **Deterministic test handshakes beat fixed delays.** FIX 6's test originally used a 1200ms fixed
  image-reload delay (flaky + slow). Rewriting it with a `deferred()`-based gate on the reload
  request (+ an `/api/list` call-counter to prove the correct-code path takes zero list refetches)
  made it deterministic, ~2× faster (595ms), and mutation-proven to kill both regressions.
- **Bare deferred promises need a bounded wait.** `node:test` has no default per-test timeout, so a
  handshake promise that never resolves (if a future regression breaks revert before it requests the
  image) would hang forever and leak Chromium. `waitWithTimeout(promise, ms, label)` (Promise.race
  - rejecting timeout) fails fast into `withEditor`'s finally-cleanup instead.
- Windows quirks held: use `view` not `read_text_file`; run renderer tests via `node --test` from
  the tests dir (Playwright/chromium ~22s); don't run `lab-gate-check.sh` locally.

### Mistakes Made

- **Over-estimated the tier early.** Anchored on 4–5🍎 before confirming the shipped-game-data
  changes (manifest/PNG/catalog) were EXCLUDED strays, which makes the committed PR1 tooling-only
  (≤3🍎 cap). Early signal: the INCLUDE set is entirely `scripts/sprites`, `.github/extensions`,
  `src/devtools` — no `src/core|engine|game`. Resolution: ran the fuller harness anyway (never wrong
  to over-review) and surfaced the nuance to the maintainer rather than silently re-scoring at PR time.
- **Round 3 confusion over canvas-harness files.** Briefly mistook the 6 `canvas-harness.mjs` edits
  for strays; they are FIX 1 (CSRF guard, canonical + byte-synced vendored copies) and are in scope.
  Early signal: `harness-drift.test.mjs` is CI-blocking and fails if vendored copies drift from canonical.

### Opportunities for Future Improvement

- The review loop ran to 8 rounds. Most late rounds were single trivial test-quality nits. A
  "promote recurring test-harness patterns (deferred-gate + bounded-wait) into a shared test helper"
  pass would prevent re-discovering them per-PR.
- Consider a lint that flags a fixed `setTimeout`/delay in a Playwright canvas test in favor of the
  deferred-gate pattern.
- `sprites:asset-pr` union flow (PR3 target) is the main source of the manifest-clobber class this
  whole feature exists to fix — retiring it should be prioritized once PR2's reconciler lands.
