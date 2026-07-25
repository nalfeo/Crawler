# Handoff: Resumable cloud art pipeline

**Date:** 2026-07-25
**Persona:** Producer, routing implementation to DevOps Engineer and validation to QA Engineer
**Apples:** 3 estimated, 3 actual (exact; tooling-only cap)

## Systems touched

sprite-pipeline, sprite-workflow, azure-infra, ci-policy

## Outcome

The trusted `asset-request.yml` workflow now carries an issue from generation through
postprocessing, VLM judging, deterministic selection of up to three acceptable variants,
durable approval, and publication to one canonical `assets/queue` pull request. The
workflow creates or updates that ready-for-review PR and never auto-merges it.

The implementation was recovered from the stalled `Audit asset requests` session and
replayed onto current `main` with Git's three-way merge so later queue-persistence fixes
were preserved.

The first push also exposed 28 current-`main` Prettier violations in unrelated TypeScript
files. The repository formatter was applied mechanically so the mandatory pre-push gate
could pass; no behavior was intentionally changed by that cleanup.

## What changed

- Added durable per-issue checkpoints for synthesize, brief selection, promotion,
  generation, postprocessing, judging, variant selection, and publication.
- Added bounded stage retries: transient failures get at most three attempts, permanent
  failures stop immediately, and completed stages resume without repeating provider work.
- Split generation from postprocessing and judging so retries do not regenerate good
  source output.
- Added a deterministic selector that admits candidates with at most two sensor failures,
  requires the judge's hard-block contract to have been evaluated, rejects explicit hard
  blocks, ranks by sensor failures, judge score, confidence, and stable variant index, and
  returns at most three variants.
- Extended the judge contract with explicit hard-block fields and confidence metadata;
  legacy scorecards fail closed until reevaluated.
- Added a trusted, narrowly gated CI capability to `runQueueCommit`; ordinary CI callers
  remain refused.
- Added a publisher that authoritatively scans terminal checkpoints, rematerializes run
  artifacts into disposable staging roots, approves selected variants deterministically,
  validates exact manifest/catalog/PNG payload identity, CAS-unions onto `assets/queue`,
  and creates or edits exactly one canonical PR.
- Added fail-closed handling for duplicate canonical PRs, queue/main merge conflicts, and
  same-key payload differences. A stale canonical PR is commented on and closed when a
  destination conflict requires human reconciliation.

## Review-driven fixes

The first code-review round found three issues, all addressed before the clean round:

1. Validate current `main` before `runQueueCommit` can push, preventing a conflicting
   asset from being stranded on `assets/queue`.
2. Isolate malformed checkpoint JSON per key so one corrupt status document cannot abort
   publication of every other ready issue.
3. Lock in the intended ranking-only semantics for `judgeScorecard.passed` with a test:
   an evaluated, non-hard-blocked candidate may still be selected when its strict judge
   pass flag is false.

## Validation

- Targeted sprite pipeline: 8 files, 120 tests passed.
- Workflow contract: 4 tests passed.
- `npm run typecheck` passed.
- `npm run verify:fast` passed: 26 changed-test files / 377 tests plus the 4 workflow
  tests, lint, typecheck, and deterministic coverage guards.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-24-resumable-cloud-art-pipeline.review-ledger.json`
  (3-apple plan review plus a two-round code-review loop ending clean).

## Operational notes

- Publishing is sequential under the existing workflow concurrency group.
- `SPRITES_ALLOW_CI_ASSET_PUBLISH=true` is accepted only for the canonical GitHub Actions
  workflow identity and the in-code `asset-request-publisher` capability.
- The workflow PAT is required so the generated-art PR triggers normal pull-request CI.
- This change automates ingestion publication only; wiring newly generated art into game
  consumers remains a separate non-art PR after review and merge.
