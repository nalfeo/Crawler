# Handoff: Epic creation workflow

## Date

2026-08-24

## Persona

DevOps Engineer

## Systems touched

ci-policy, docs-tooling

## Apples

Estimated: 3🍎; actual: 3🍎

## Summary

Added and recovered the generic `*.epic.json` → GitHub issues workflow. The workflow creates a human-review issue first, waits for a human `completed` close, then materializes dependency-ordered implementation issues.

Review recovery tightened the workflow so the reviewed revision is exactly what can materialize:

- Epic review/node markers are centralized in `.github/scripts/ci-recovery/markers.mjs` and inventoried with the other managed `<!-- crawler-...` markers.
- The review hash now covers global labels and all reviewed/materialized fields.
- Cyclic node dependencies fail validation before any GitHub mutation.
- Review issues render node titles, bodies, dependencies, and global/node labels.
- Label creation only suppresses structured `Label`/`name`/`already_exists` 422 races; validation 422s surface.
- Completed review closes require `closed_by.type === "User"`; bot closures fail closed.
- Node markers are revision-scoped, and post-materialization revisions for the same `epic_id` are rejected instead of reusing stale issues.
- Rejection is documented as reversible while the review issue is reopened; post-materialization follow-up work should use a new `epic_id`.

## Files touched

- `.github/scripts/epics/epic-create.mjs`
- `.github/scripts/epics/epic-create.test.mjs`
- `.github/scripts/ci-recovery/markers.mjs`
- `.github/workflows/epic-create.yml`
- `docs/guides/epic-creation-workflow.md`
- `docs/knowledge/review-ledgers/2026-08-24-epic-creation-workflow.review-ledger.json`

## Verification run

- `bash scripts/agent/preflight.sh` — passed after syncing/rebasing onto `origin/main`.
- `node --test .github/scripts/epics/epic-create.test.mjs .github/scripts/ci-recovery/router.test.mjs` — passed.

## Unresolved issues

- None known.

## Recommended next steps

- If maintainers need to revise an epic after implementation issues exist, author a new `epic_id` for the follow-up graph so old and new issue sets remain auditable.
