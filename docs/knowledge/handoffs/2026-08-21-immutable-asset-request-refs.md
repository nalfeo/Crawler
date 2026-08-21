# Session Handoff: Immutable asset request refs replace the mutable `assets/queue`

## Date

2026-08-21

## Persona

Sprite/DevOps Engineer (tooling)

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

3🍎 estimated, 3🍎 actual (tooling-only ceremony cap applies).

## What Was Done

Implemented issue #3205: asset mutations are now sealed, independently
verifiable Git **request refs** instead of entries appended to the long-lived
mutable `assets/queue` aggregate branch.

New module family `scripts/sprites/asset-requests/`:

- `manifest.ts` — the pure contract. Content-derived request IDs (SHA-256 over
  canonical JSON of the body), fail-closed body validation, declared-path
  derivation, destination-unit derivation (annotations are per key), ref naming.
- `publish.ts` — hash-verifies PNG bytes _before_ writing any git object, builds
  an orphan commit via plumbing with a fixed identity/date (so replay is
  byte-identical and publishing is idempotent), then creates the ref under a
  CAS lease. Refuses `ref-exists-with-different-content`.
- `reconcile.ts` — materializes a promotion from **current `origin/main`** and
  the validated unresolved requests; per-request refusal reasons; conflict
  partitioning that refuses all claimants of a contested destination rather than
  picking a silent winner; art-surface-only assertion; promotion trailers naming
  every consumed request/source SHA; archive-only-after-merge-proof.
- `migrate-queue.ts` — deterministic cutover classifier over the final queue
  tip; the report is complete only when nothing is left unclassified.
- `cli.ts` / `runtime.ts` — `npm run sprites:asset-request
publish|reconcile|archive|migrate`.

Legacy writer `scripts/sprites/queue-commit.ts` gained a `queue-frozen`
fail-closed refusal driven by `SPRITES_ASSET_QUEUE_FROZEN`, which fires before
any git call and applies to the trusted CI publisher too.

Runtime/real-artifact observation: this is git-tooling, not gameplay, so the
real artifact is a git repository. All three real-git suites
(`publish.test.ts`, `reconcile.test.ts`, `migrate-queue.test.ts`) drive a real
temp bare origin + clone via `tests/unit/sprites/asset-requests/harness.ts` —
before: a stale request could overwrite newer `main` bytes and a queue write
always succeeded; after: the stale request is refused `stale-destination` and a
frozen queue write throws `queue-frozen` with zero git calls. 36 asset-request
tests plus 49 queue-commit tests pass.

## Key Decisions Made

- **Content-derived request IDs.** The ID is the hash of the manifest body, so
  editing a request in place is detectable and idempotent republication is free.
- **Orphan commits with declared payload only.** The reconciler diffs
  `ls-tree -r` against `declaredRequestPaths()` and refuses
  `undeclared-payload`, which is what makes "a single request cannot overwrite
  unrelated sprites" enforceable rather than aspirational.
- **Annotations are per key.** The conflict unit is `<path>#<key>`, so two
  sprites' annotation edits never collide and no request ever carries a whole
  document.
- **Validation order is load-bearing.** `already-on-main` must be checked before
  staleness — a request's _own_ landed promotion changed the destination bytes,
  and reporting that as `stale-destination` is wrong. This was a real bug caught
  by the reconcile suite.
- **Archive only after merge proof.** Copy-to-archive then lease-delete, gated
  on the promotion being proven merged, so no request is lost or double-consumed
  across a crash/retry.

## What's Next / Blockers

The cutover is deliberately staged and needs human dispositions (issue §Cutover
steps 2–7):

1. Set `SPRITES_ASSET_QUEUE_FROZEN=1` in the asset workflows once the request
   writer is deployed, and snapshot the final queue tip to an immutable backup
   ref.
2. Run `npm run sprites:asset-request migrate` against that tip and get a human
   decision on every `requires-human` / `naming-migration-conflict` group.
3. Publish the approved `safe-request` groups, reconcile them, and verify the
   promotion diff.
4. Only after the observation period: archive `assets/queue` and retire the old
   writer/reconciler paths. **Never delete the final queue snapshot or the
   migration report.**

Workflow wiring (`.github/workflows/`) intentionally still points at the legacy
path until step 1 is executed by a human — flipping it in this PR would freeze
production ingestion before the migration report exists.

## Retrospective

### Lessons Learned

- `tests/unit/sprites/**` is excluded from the `unit` vitest project — it runs
  under `--project sprites`. Running the file path alone silently matches
  nothing.
- `Exec` in `scripts/sprites/checkin.ts` has no stdin support, so building
  commits by plumbing must use `update-index --cacheinfo` under a scratch
  `GIT_INDEX_FILE` rather than `mktree`/`hash-object --stdin`.
- Fixing commit author/committer identity **and** date is what makes replay
  byte-identical; leaving the date to `now` quietly destroys idempotency and
  the determinism acceptance criterion with it.

### Mistakes Made

- Ordered `validateRequest`'s checks by "cheapest first" instead of by meaning,
  which made a request that had already landed report as `stale-destination`.
  Early signal: a test asserting `already-on-main` failed with a _different_
  refusal reason rather than passing — a wrong refusal kind is a design smell,
  not a test-expectation nit.
- Wrote the freeze message referencing `npm run sprites:asset-request` before
  the script existed in `package.json`. Actionable error messages have to be
  actionable at the moment they are written.

### Opportunities for Future Improvement

- The reconciler currently refuses both claimants of a contested destination.
  A follow-up could emit a machine-readable conflict record that the sprite
  gallery surfaces for one-click human adjudication.
- The archive ledger is a set of refs; a compacted, signed ledger ref would make
  long-horizon audit cheaper than walking thousands of archive refs.
