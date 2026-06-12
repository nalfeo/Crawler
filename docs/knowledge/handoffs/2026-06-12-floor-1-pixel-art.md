# Floor 1 Pixel Art Placeholder Pass

**Context:**
Replaced procedural fallback shapes with actual CC0 Kenney pixel art sprites for Floor 1 to make it look like a "modern pixel art dungeon crawler" instead of an Atari game. This is still placeholder art pending actual custom sprite synthesis, but significantly improves visual fidelity.

**Changes:**

- Removed `shouldForceColorFallback` logic in `src/engine/terrain-renderer.ts` to allow pixel art tiles to render.
- Added tile sprite mappings for `BOSS_STAIR_FLOOR`, `SAFE_ROOM_FLOOR`, and `WOOD_WALL` in `src/engine/sprites/tile-visuals.ts`.
- Added missing sprite mappings (rats, slimes, bosses, NPCs, gems, projectiles) to `src/engine/sprites/registry.ts`.
- Mapped engine entities to new pixel art placeholders in `src/engine/PhaserBridge.ts`.

**Complexity:** 🍎🍎 (Routine configuration and logic update)
**Verdict:** Completed.
