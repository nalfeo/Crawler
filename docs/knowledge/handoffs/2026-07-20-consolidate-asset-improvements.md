# Session Handoff: Consolidated sprite asset improvements

## Summary

Consolidated PRs #1738, #1739, and #1746 into PR #1740 so the sprite workflow
ships as one coherent asset-improvement change: shared Azure resource caching,
managed sidecar lifecycle, one-click atomic acceptance, and richer sprite
judging plus criterion feedback.

## Systems touched

`sprite-pipeline`, `sprite-workflow`, `azure-infra`, `devtools`

## Source PRs

- #1738 — shared Azure sprite resources across sessions
- #1739 — managed sprite sidecar lifecycle across canvases
- #1746 — improved sprite judging and criterion feedback
- #1740 — atomic accept-and-queue workflow (consolidated target)

The three source branches were merged into #1740 in dependency order:
cache, sidecar lifecycle, then judging/feedback. Their overlapping sidecar and
workflow contracts were resolved by preserving all four behaviors.

## Integration decisions

- The managed sidecar uses `SPRITE_SIDECAR_SERVICE_VERSION` while retaining
  exact per-worktree trusted mutation origins.
- Shared-cache slice-map versioning and offline behavior coexist with the
  process-wide accept/check-in mutation lock.
- Workflow startup state and one-click acceptance state are both present in
  degraded and healthy canvas states.
- Judge-axis additions coexist with accepting, queued, retry, and batch-warning
  UI states.
- Criterion feedback writes use atomic temp-file rename, recover from truncated
  JSON, and return structured 400/413 responses for invalid requests.

## Validation

- `npm run test:sprites`
- `npm run test:guards`
- `npm run verify:fast`
- Focused feedback persistence/request tests
- Dedicated adversarial plan review, two-round code review, and clean
  multi-model review with independent adjudication

## Runtime and artifact notes

The consolidated PR intentionally includes judge taxonomy, brief/plan metadata,
the generated manifest migration, and the criterion-feedback store from #1746.
Locally generated PNGs not already present on `main` remain stashed outside the
PR and continue through the durable asset-checkin queue.

## Apples

Estimated: 4🍎. Actual: 5🍎.
