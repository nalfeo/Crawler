# Sprite Editor Cache Hydration

**Date:** 2026-08-17  
**Type:** Developer tooling performance and correctness fix  
**Apples:** 3

## Systems touched

sprite-workflow, devtools

## Summary

Made Sprite Editor switching durable-cache backed and non-mutating:

- Added a fingerprint-gated, atomic composed-manifest snapshot under
  `$COPILOT_HOME`, with deferred proactive hydration on extension startup.
- Throttled the 642-shard fingerprint walk and explicitly invalidated all cache
  layers after editor writes.
- Replaced timestamp image URLs with content-versioned immutable URLs and
  best-effort adjacent-sprite prefetching.
- Fixed the false-dirty guard that compared canvas bytes after `loadImage()`
  had deliberately replaced the canvas. The stale baseline prompted click-only
  saves, which spawned a queue-commit git push and made switching take 5-20s.
- Restored canonical fireball and baby-slime PNGs after the current
  self-consistent shard mappings rendered a baby slime for fireball and a sword
  for baby slime. The existing hash-only asset integrity check cannot detect
  semantic image swaps when the wrong hash is also written to the shard.
- Added browser and snapshot regression coverage, including a sub-second clean
  switch budget.

## Root cause

The post-image-load edit guard reused the full editor fingerprint. Because that
fingerprint includes the PNG data URL, every legitimate canvas replacement
looked like an edit and aborted before `resetBaseline()`. The first sprite's
baseline then remained active, so each later selection prompted an unintended
save.

## Validation

- `node --test ".github/extensions/sprite-editor/tests/*.test.mjs"` (46 passing)
- `npm run verify:fast`
- `npx prettier --check .github/extensions/sprite-editor/`
- `npm run check:extensions`
- `npm run check:asset-integrity`
- Real canvas observation: 10 clean switches had no dialogs, 236ms maximum, and
  131ms average.
- Real canvas observation: restored fireball and baby-slime selections render
  their intended images after extension reload.
