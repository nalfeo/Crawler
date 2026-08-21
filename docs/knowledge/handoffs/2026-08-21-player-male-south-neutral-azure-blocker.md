# Handoff: male player south neutral Azure workflow blocker

**Date:** 2026-08-21  
**Mode:** production Azure Sprite Generation Workflow  
**Apple estimate / actual:** 1🍎 / 1🍎 (art-only; no approval, queueing, wiring, or engine change)

## Systems touched

- Sprite Generation Workflow canvas/managed Azure sidecar (read-only inspection)
- Asset Request Pipeline workflow run `32455386371` (prior failed production attempt)

## Outcome

The canvas brief discovery path finds
`briefs/characters/player-male-south-neutral.yaml` in this worktree, and the
managed sidecar is healthy with `azure-blob` storage and `azure-queue` enabled.
The canvas extension is read-only for mutations, so the canonical control path
is `POST /api/workflow/generate`, followed by the CI-only
`Asset Request Pipeline` consumer.

Do not enqueue another run until the production checkout can resolve the brief's
seed frame. The prior Asset Request Pipeline run `32455386371` failed before
Azure image generation with:

```text
generateSheetCore: seed frame path
"briefs/characters/seeds/player-male-neutral-front.png" does not exist or cannot be resolved
```

The referenced seed and the source brief exist only as untracked worktree files;
they are not present on the remote `main` checkout used by the CI-only queue
worker. The sidecar mirrors the YAML brief to Azure but does not upload local
seed-frame bytes, so retrying would reproduce this deterministic failure.

## Required follow-up

Publish the scoped brief and seed frame to the branch/ref consumed by the Asset
Request Pipeline (or add canonical seed-frame durability to that workflow), then
submit the existing full YAML via `/api/workflow/generate`, run the CI worker,
postprocess with the content-aware slicer, and judge without approval.
