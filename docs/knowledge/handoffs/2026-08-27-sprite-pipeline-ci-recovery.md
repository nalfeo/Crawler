# Sprite pipeline CI recovery

**Date:** 2026-08-27  
**Persona:** Graphics Designer  
**Apples:** 2 estimated / 2 actual

## Systems touched

sprite-pipeline, sprite-workflow

## What changed

- Merged current `main`, retaining both workflow polling and generation-nonce
  safeguards in the sole conflict.
- Provisioned Python 3.12 and the pinned post-processing requirements for the
  Sprite Pipeline Tests job.
- Pinned Pillow 12.1.0, which satisfies `proper-pixel-art==1.7.2` and restores
  the `PIL` import required by strict post-processing.

## Deterministic evidence

- Isolated Python 3.12 requirements installation and `PIL` / `proper_pixel_art`
  imports — passed.
- `npm run test:sprites` — passed (147 files, 2,410 tests).
- Workflow poller and extension security tests — passed (30 tests).

## Remaining concerns

- The dependency advisory lookup could not authenticate in this environment;
  Pillow 12.1.0 was selected because it is the minimum version accepted by the
  pinned `proper-pixel-art` release.
