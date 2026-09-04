# 2026-09-04 Goobers Phase 3 Lane A: review-thread reply/resolve

## Summary

Shipped a bounded slice of the Phase 3 Goobers migration (#3841 / epic #3838):
Lane A only — review-thread reply/resolve is now migratable to Goobers behind
`LIFECYCLE_OWNER_REVIEW_THREADS`. A new deterministic decision script
reproduces reconcile.mjs's exact two-phase legacy behavior (post an
`✅ Addressed` outdated-marker reply, then resolve), a new Goobers workflow
runs it, and a new hosted wrapper applies the decision after re-validating
thread state immediately before every write. Legacy still owns the lane by
default; nothing mutates differently until an operator explicitly sets the
selector to `goobers`.

## Systems touched

ci-policy

## What changed

- Extracted `reviewThreadReplyCommentId` (and its
  `REVIEW_DISCUSSION_COMMENT_PATTERN` regex) out of `reconcile.mjs` into an
  exported helper in `ci-recovery/state.mjs`, with no behavior change.
- Added `.github/scripts/goobers-review-threads.mjs`: a pure,
  side-effect-free `decideReviewThreadActions({ threads, headSha,
reachableCommitShas })` that reproduces reconcile.mjs's two-phase
  post-outdated-marker/resolve pass, plus a CLI entrypoint for Goobers to
  invoke as a deterministic task.
- Added `.goobers/gaggles/crawler/workflows/crawler-review-threads.yaml`
  (Goobers workflow source, `expectedOutputs: [decisions]`) and
  `.github/workflows/goobers-review-threads.yml` (hosted wrapper), modeled on
  `crawler-lifecycle-owner`/`goobers-lifecycle-owner.yml`. The wrapper:
  - no-ops (fail-closed for this Goobers-side writer) unless
    `vars.LIFECYCLE_OWNER_REVIEW_THREADS == 'goobers'`;
  - pins the same `GOOBERS_VERSION`/`GOOBERS_SHA256` (`v0.3.3`) already used by
    `goobers-lifecycle-owner.yml`/`goobers-shadow.yml`;
  - re-fetches the PR head SHA and each thread's live state immediately
    before writing (fenced apply — a stale or superseded decision never
    mutates);
  - uses the job's own `github.token`, not `CRAWLER_CI_PAT`: a
    `github-actions[bot]`-authored reply already satisfies the marker-trust
    check in `ci-recovery/state.mjs` (`TRUSTED_BOT_LOGINS` already includes
    it), and resolving a thread only needs `pull-requests: write`. Unlike the
    Phase 2 implementation-claim lease, no elevated PAT is required.
- Added ONE best-effort dispatch hook in `reconcile.mjs`
  (`dispatchReviewThreadsGoobersOnce`), fired at most once per reconcile run
  the first time `legacyReviewThreadWritesEnabled()` is false, wrapped in
  try/catch so a dispatch failure can never crash reconcile or block
  `release()`.
- Docs: `.goobers/README.md` (Phase 3 Lane A paragraph),
  `docs/runbooks/ci-mutation-bridge-runbook.md` (ownership table gained a
  "Phase 3 status" column; added the `LIFECYCLE_OWNER_REVIEW_THREADS`
  migration/rollback recipe; updated "Known limitations").
- Tests: `.github/scripts/goobers-review-threads.test.mjs` (unit coverage for
  `decideReviewThreadActions`, including the marker-collision idempotency
  property), `.github/scripts/goobers-review-threads-workflow-gating.test.mjs`
  (rollback-toggle / least-privilege / no-merge-train-touch properties on the
  hosted workflow YAML), and two new cases in
  `.github/scripts/ci-recovery/reconcile.test.mjs` asserting the dispatch
  fires exactly once when migrated and never when left on legacy.

## Explicitly deferred (out of scope for this task)

- **Lane B** (CI Recovery router + reconciliation) — still legacy-owned via
  `LIFECYCLE_OWNER_CI_RECOVERY`; only the one best-effort dispatch hook
  described above was added to `reconcile.mjs`.
- **Lane C** (merge-train admission) and **Lane D** (merge-train promotion) —
  untouched; `merge-train.yml`'s admission/promotion gating logic was not
  modified.
- Reproducing reconcile.mjs's full stale-marker lineage/near-typo-promotion
  logic (`reachableMarkerShas`/`definitivelyMissingMarkerShas`, ~200 lines) in
  the hosted wrapper — it conservatively passes an empty
  `reachableCommitShas` set instead, the same conservative choice
  reconcile.mjs's own early-exit path already makes for the identical reason
  (the compare API call is unreachable from that path). This is a documented
  limitation, not a silent gap; see `.goobers/README.md` and the runbook.

## Verification

- `node --test .github/scripts/goobers-review-threads.test.mjs` — 8/8 pass
- `node --test .github/scripts/goobers-review-threads-workflow-gating.test.mjs` — 6/6 pass
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — 207/207 pass
  (192 pre-existing + 2 new dispatch-hook cases, unchanged otherwise)
- `npm run test:guards` — 2881/2881 pass (full `.github/scripts`,
  `.github/extensions`, `scripts/agent` discovery)
- `npx eslint .github/scripts/goobers-review-threads.mjs
.github/scripts/goobers-review-threads.test.mjs
.github/scripts/goobers-review-threads-workflow-gating.test.mjs
.github/scripts/ci-recovery/reconcile.mjs .github/scripts/ci-recovery/state.mjs
.github/scripts/ci-recovery/reconcile.test.mjs --max-warnings 0` — clean
- `npx prettier --write` on all new/changed `.github/scripts/**` files
- `python3 -c "import yaml; yaml.safe_load(...)"` on both new workflow YAML
  files — parses cleanly
