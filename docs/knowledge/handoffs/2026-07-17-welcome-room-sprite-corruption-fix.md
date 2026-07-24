# Welcome-Room Sprite Corruption Fix

**Date:** 2026-07-17
**Session:** Fix welcome-room sprite mismatch (issue #1249)
**Type:** Art-only

## Systems touched

sprite-pipeline

## Summary

Restored the four welcome-room set-piece sprite PNG files to their correct
pre-corruption state. They were inadvertently replaced with wrong content in PR
#1138 (commit `781e17ef`).

## Root cause

In commit `781e17ef` ("art: approve boss, welcome-room, and ability-icon sprites
from shepherd session"), all four welcome-room sprite PNG files and their
`contentHash` entries in `manifest.json` were replaced with incorrect content:

| Sprite                           | Broken content (after 781e17ef)          | Correct content (restored)               |
| -------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `welcome-room-bookcase-var-0`    | 64×64 olive-green goblin-like art        | 96×91 bookcase (from ed56521c reprocess) |
| `welcome-room-desk-var-0`        | 96×91 — was the old bookcase             | 144×95 desk (from ed56521c reprocess)    |
| `welcome-room-rug-var-0`         | 144×95 — was the old desk                | 128×73 rug (from ed56521c reprocess)     |
| `welcome-room-velvet-rope-var-2` | 128×73 — was the old rug (SHA-confirmed) | 96×67 rope (from ed56521c reprocess)     |

The SHA-256 hash of the old rope file (128×73) exactly matches the pre-corrupt
rug hash `dff65037...`, proving the rug content was placed in the rope slot.

## Fix

Restored the four PNG files from `git show 781e17ef^` (the pre-corruption state
produced by the `ed56521c` fixed-slicer reprocess) and updated their
`contentHash` entries in `manifest.json` to match.

## Files touched

- `public/assets/generated/welcome-room-bookcase-var-0.png`
- `public/assets/generated/welcome-room-desk-var-0.png`
- `public/assets/generated/welcome-room-rug-var-0.png`
- `public/assets/generated/welcome-room-velvet-rope-var-2.png`
- `public/assets/generated/manifest.json` — 4 contentHash entries updated

## Verification

- `verify:fast`: 87 test files, 1254 tests — all pass
- SHA-256 hashes of restored PNGs match expected pre-corruption values
- `manifest.json` contentHash entries verified to match actual file hashes

## Unresolved issues

None. The corruption was confined to the 4 PNG files and their manifest hashes.
All JSON references (set-pieces.json, sprite-catalog.json, manifest.json keys)
were already correct.
