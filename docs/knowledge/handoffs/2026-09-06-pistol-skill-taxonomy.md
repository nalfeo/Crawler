# 2026-09-06 pistol-skill-taxonomy

## Systems touched

weapons, vfx

## Summary

- Fixed the active pistol milestone VFX layer to resolve by the canonical IDs (`pistol-rapid-fire`, `pistol-barrage`) instead of the stale legacy aliases (`pistol-volley`, `pistol-volley-evolved`).
- Preserved legacy alias compatibility so older item IDs still map to the same runtime effect while the player-facing registry remains canonical and human-readable.
- Added deterministic regression coverage for the pistol unlock taxonomy and VFX wiring so classification/name drift is caught by tests.

## Validation

- `npx vitest run tests/game/ability-registry.test.ts tests/game/weapon-skill-abilities.test.ts --reporter=dot`
- `bash scripts/agent/verify-fast.sh`
