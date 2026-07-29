# Session Handoff: Config-Driven Sprite Wiring & Asset Hookup

**Date:** 2026-06-30  
**Branch:** nalfeo-fix-slime-sprite-wiring  
**Apple Estimate:** 3🍎

## Executive Summary

This branch fixes the slime-art regression by moving sprite wiring out of hardcoded bridge maps and into shared config. Slimes, rats, baby slimes, the rat-slime boss, and the baseball bat icon now resolve through config-backed generated-art wiring instead of stale placeholders.

## Root Causes Fixed

1. Hardcoded texture maps in the bridge kept approved art from taking effect.
2. Spawner templates defaulted multiple enemies to texture ID 0.
3. Baby slimes inherited the parent slime texture ID instead of using their own identity.
4. Inventory icons ignored `def.icon` overrides.
5. Wiring automation still targeted the old bridge-based texture mapping.

## Files Modified

### Configuration & Types

- `src/shared/data/entity-sprite-mappings.json` - added config-driven render-kind wiring, baby slime texture ID, and pinned generated keys
- `src/shared/data/entity-sprite-mappings.d.ts` - added render-kind typing

### Engine

- `src/engine/PhaserBridge.ts` - replaced hardcoded texture maps with config-driven resolution and hot-upgrade reconcile
- `src/engine/phaser-bridge/textures.ts` - centralized procedural texture tokens
- `src/engine/phaser-bridge/sprite-kind.ts` - derives enemy variants from config
- `src/engine/InventoryUI.ts` - resolves generated icons from `def.icon ?? def.id`

### Gameplay & Labs

- `src/game/spawners/registry.ts` - reads configured texture IDs for mob templates
- `src/core/systems/dropSystem.ts` - assigns the configured baby-slime texture ID on split
- `src/labs/spawner-lab/index.ts` - loads generated art for visual verification
- `scripts/sprites/generate-wiring.ts` - patches shared config instead of old bridge maps

### Tests

- `tests/unit/phaser-bridge.test.ts`
- `tests/unit/phaser-bridge-sprite-kind.test.ts`
- `tests/ecs/drop-system.test.ts`
- `tests/game/spawner-registry.test.ts`

## Verification

- `npm run verify:fast`
- `bash scripts/agent/lab-gate-check.sh`
- Playwright visual verification in the spawner lab confirmed slime generated art is on-screen

## Architecture Decision

ADR 0034 documents the config-driven sprite wiring decision and its tradeoffs.

## Remaining Non-Bug Content Gaps

These approved assets still need gameplay/content work rather than more sprite wiring:

- `bent-pipe-v1`
- `purple-potion-v1`
- `green-slime-baby-v1`
- `slime-king-v1`
- `slime-queen-v1`

## Notes

- A follow-up regression fix restored the Kenney mappings for `aoe_proj` and `enemy_aoe_proj`.
- The bridge reconcile path now caches preferred enemy textures per sync pass to avoid repeated full texture-key scans while generated art is missing.
- The `aoe` render kind keeps the pre-refactor `melee` procedural fallback, so it does not silently fall through to the default bullet placeholder.
