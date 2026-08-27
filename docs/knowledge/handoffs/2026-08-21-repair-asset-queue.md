# Repair asset queue

**Date:** 2026-08-21  
**Persona:** DevOps Engineer  
**Apples:** 3 estimated / 3 actual

## Systems touched

sprite-pipeline, sprite-workflow

## What changed

- Recovered the remote `assets/queue` branch from current `main`, retaining only
  the reviewed llama, welcome-room, and annotation changes. The former corrupted
  tip is preserved under
  `refs/asset-queue-backups/1c1243b0652b6b79720154593d0f59c6b3a9aebf`.
- Added a source-bound recovery command pinned to the reviewed editor batch. It
  verifies retained PNG/shard hash pairs, merges only the reviewed annotation
  keys, requires expected main and queue SHAs, and creates a backup ref before
  rewriting the queue.
- Made normal ingestion fail closed when the remote queue has generated-path
  deletions, and made stale-duplicate pruning require a source-bound manifest
  proving every removal is a same-content canonical duplicate.

## Deterministic evidence

- Focused sprite recovery, pruning, and queue tests - passed.
- `npm run typecheck -- --pretty false` - passed.
- `npm run verify:fast` - passed before the pre-publish rebase; rerun is required
  on the rebased head before publication.
- `git diff --check` - passed.

## Remaining concerns

- The recovery command is intentionally one-time policy, not the durable queue
  architecture. The tracked immutable per-request-ref migration issue owns the
  long-term cutover.
- The manually started reconciler run was stopped before a promotion result, so
  do not claim retained assets have reached `main` until a subsequent reconciler
  run confirms it.
