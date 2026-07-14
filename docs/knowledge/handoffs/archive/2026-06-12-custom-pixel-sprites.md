# Custom Pixel Art Sprites

**Context:**
The previous fallback textures were mapped incorrectly to Kenney sprites, making them look like Atari sprites (e.g. rats mapped to small bats, slimes totally invisible). The user requested custom pixel art sprites instead.

**Changes:**

- Generated `custom-pixel-sprites.png` with 19 new custom 16x16 pixel sprites (player, orc, goblin, rat, slime, boss, NPCs, gems, projectiles, VFX, explosions, dead skull, etc.) using `pngjs` and a custom layout.
- Added `CUSTOM_PIXEL_SPRITES` as a sheet in `src/engine/sprites/registry.ts`.
- Mapped all `PhaserBridge.ts` entity visual types to use the custom sprite sheet.
- Cleaned up hardcoded fallback procedural textures so they use `resolveTexture` consistently and will render the actual pixel art.

**Complexity:** 🍎🍎🍎 (Significant texture logic wiring and custom asset generation)
**Verdict:** Completed.
