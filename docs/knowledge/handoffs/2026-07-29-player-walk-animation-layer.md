# 2026-07-29 — Player walk animation layer (Slice A)

## Summary

Built the FIRST Phaser animation layer in the Crawler engine (there was previously
zero animation infrastructure — no `anims.create`/`anims.play`/`generateFrameNumbers`
anywhere in the repo), and used it to give the player character a walking cycle. This
is Slice A of a two-slice effort; Slice B (a parallel session) extends the
sprite-generation pipeline to produce multi-frame sheets that will consume the same
shared contract this slice defines. This session only touched the consumer
(engine) side.

Previously the player rendered as a single static frame (Kenney Tiny Dungeon sheet,
frame 96) and **never mirrored when walking left** — that bug is also fixed here.

## Shared contract (owned by this slice)

`src/shared/generated-assets.ts` — added an optional `animation` descriptor to the
manifest entry schema:

```ts
animation: z.object({
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  frameCount: z.number().int().min(2),
  frameRate: z.number().positive(),
  loop: z.boolean().default(true),
}).optional();
```

Surfaced on `GeneratedSpriteEntry.animation?: GeneratedSpriteAnimation` (type
exported). Backward compatible — entries without `animation` behave exactly as
before (flat `loader.image`).

**Documented layout contract** (added during plan review, since this is the exact
shape Slice B must produce): the PNG is a **single-row, left-to-right spritesheet
strip**, frames indexed `0..frameCount-1`, and **frame 0 doubles as the idle/resting
pose** — there is no separate idle-frame field.

## What was built

1. **Schema + type** in `src/shared/generated-assets.ts`, unit-tested (entry with/without
   `animation`, and rejection of invalid descriptors — `frameCount < 2`,
   non-positive `frameRate`).
2. **Spritesheet routing** in `src/engine/generatedAssets/preload.ts`
   `preloadGeneratedSprites()` — entries with an `animation` descriptor go through
   `loader.spritesheet(textureKey, url, { frameWidth, frameHeight })`; everything
   else keeps `loader.image()`. `LoaderLike` gained an optional, guarded
   `spritesheet` method (same defensive `typeof x.foo === 'function'` style used
   elsewhere). The introspection array returned now records which path each entry
   took.
3. **Animation registration**: new module `src/engine/generatedAssets/animations.ts`
   — given a scene + the generated sprite registry, registers one Phaser animation
   per animated entry (key: `<textureKey>:walk`), using `frameRate`/`loop` from the
   descriptor. Idempotent (skips if the anim key already exists) and guards on
   `scene.anims` existing (headless/test scenes without it are unaffected).
4. **Player walk playback** in `src/engine/PhaserBridge.ts` — the player's render
   path (previously falling into the generic `default:` case with no special
   handling) now:
   - Derives speed from the velocity store; plays the walk animation above
     `PLAYER_WALK_SPEED_EPSILON_SQ` and stops it at rest.
   - On stop, calls `setFrame(0)` to snap the sprite to the documented idle pose
     instead of freezing on whatever mid-stride frame the animation loop happened
     to land on (Phaser's `anims.stop()` does NOT reset frame index — this was a
     plan-review must-fix).
   - Adds the previously-missing `setFlipX` mirroring for the player. **Fix
     applied during code review**: the first implementation re-derived facing
     from `vx > epsilon` on every tick, which incorrectly mirrored the player to
     face left whenever `vx === 0` (standing still, or walking straight up/down).
     Now only re-derives facing when `|vx|` exceeds the flip epsilon; otherwise
     preserves the sprite's current `flipX`.
   - All new Phaser calls guarded (`typeof x.foo === 'function'`) so existing
     tests with stub sprites/images keep passing.
5. **Placeholder art**: a hand-authored, obviously-placeholder-quality 3-frame
   side-view player walk sheet (64×64 per frame) committed under `public/assets/`,
   wired via `entity-sprite-mappings.json`'s `pinnedTextureKey`
   (`player-walk-placeholder-v1-var-0`). The original static frame remains the
   idle pose (frame 0). Slice B will replace this placeholder with generated art
   through the same `animation` descriptor — no further engine changes needed
   when that lands.
6. **Lab**: extended `movement-lab` (`src/labs/movement-lab/`) with animation
   debug surfacing (walk-anim state / descriptor presence) so the layer is
   visually inspectable in isolation. Note: the lab's player entity is a
   placeholder diamond, not wired to the real generated-sprite registry, so it is
   useful for exercising the animation _mechanism_ but is not a substitute for
   observing the real game.

## Hard success gate (deterministic, headless)

`tests/unit/player-walk-animation.test.ts` exercises the REAL production path
end-to-end (`buildGeneratedSpriteRegistry` → `createPhaserBridge(scene).sync(world)`
→ real `scene.add.sprite` + `registerGeneratedSpriteAnimations` + `anims.play/stop`),
using a `MockAnimationState.tick(deltaMs)` harness addition to stand in for
Phaser's per-frame animation update. Asserts:

- The active frame index **advances** (cycles through all 3 frames) while the
  player is moving.
- The frame index **holds constant** while the player is stationary.
- On stop, the sprite **snaps to frame 0** (the idle pose) rather than freezing
  mid-stride.
- **Flip fix regression coverage** (added during code review): moving right does
  not mirror; walking straight up (vx=0) and coming to a full stop **preserve**
  the last horizontal facing rather than re-deriving and flipping; moving left
  mirrors; moving right afterward un-mirrors.

No LLM judge, no manual eyeballing — this is the actual gate.

## Observe before/after (real game, `npm run dev`)

- **Before**: baseline behavior was captured with an equivalent deterministic
  artifact in `tests/unit/player-walk-animation.test.ts`:
  `does not create a Sprite/animation for textures without an animation descriptor`.
  That test drives the real bridge path with no generated-animation descriptor
  and proves the pre-slice behavior (`Image` only, no `Sprite.anims` surface).
- **After**: launched the real dev server (`npm run dev`), drove the player left
  and right with keyboard input, and captured full-viewport screenshots
  confirming (a) the player renders via the new generated placeholder texture,
  (b) the world/minimap position updates consistently with movement in both
  directions, and (c) no regressions to HP/combat/rendering. A pixel-level
  zoomed crop of the sprite itself was attempted but abandoned — see "Tooling
  limitation" below; the full-viewport screenshots plus the deterministic
  headless hard-gate test (which precisely proves frame-advancing/idle-holding
  behavior) together constitute the "observe before/after" evidence for this
  session.

## Tooling limitation encountered (process note for future sessions)

`chrome-devtools`'s `filePath` parameter for screenshots/scripts was rejected as
"not within configured workspace roots" for every path form tried in this
session's environment, and there was no reliable way to convert an inline
returned data-URL string back into a viewable cropped image within this
session's toolset (manual base64 retyping is error-prone for long strings and
failed twice). Future sessions needing pixel-level sprite verification should
either confirm `chrome-devtools` file-saving works in their environment first,
or budget for an alternative verification path (e.g. a dedicated screenshot
canvas/helper) rather than assuming it will work.

## Review harness

3🍎 tier — plan review + code-review loop, per
`docs/knowledge/review-ledgers/2026-07-29-player-walk-animation-layer.review-ledger.json`:

- **Plan review** (separate model, `gpt-5.4`, `plan_divergence: minor`): 2
  must-fix concerns (idle-frame semantics after `anims.stop()`; sheet layout
  semantics under-specified) — both fixed (frame-0 snap-back; explicit JSDoc
  contract).
- **Code review** (2 rounds): round 1 (`claude-opus-4.7`) found the flip
  regression described above (fixed + covered by 3 new tests); round 2
  (`claude-sonnet-4.6`) confirmed clean.

## Verification run

- `npm run verify:fast` — passed (multiple times, after each round of fixes).
- `npm run scope` — `gameplay_safe=false`, `visual_touched=true` → warranted
  heavier validation.

## Slice C scope check (added post-publish)

A late scope clarification named a follow-up Slice C that owns blood-footprint
geometry tuning and asked this PR to flag two things explicitly:

- **Footprint/trail-VFX carve-out respected.** Verified via
  `git diff origin/main...HEAD --stat -- src/shared/blood-surfaces.ts src/engine/PlayerTrailVfx.ts`
  — empty diff. Neither `createBloodFootprintSurface()`'s geometry constants nor
  `TRAIL_PUFF_FOOT_OFFSET_PX` were touched by this PR.
- **Player on-screen render size changed — likely unintentionally.** The
  player's rendered width/height is `frameWidth/Height × generated.scale` from
  `src/shared/data/entity-sprite-mappings.json` (Phaser's `setScale` multiplies
  against the native texture/frame pixel size, not a fixed target size):
  - **Before**: Kenney Tiny Dungeon frame, 16×16px native × `kenneyScale: 1.6`
    → **25.6×25.6px** on screen.
  - **After**: new placeholder walk sheet, 64×64px native frame ×
    `generated.scale: 0.72` (set in this PR's `entity-sprite-mappings.json`
    player entry) → **46.08×46.08px** on screen — **~1.8× larger (+80%)**.
  - For comparison, every generated-art enemy entry in the same file uses
    `generated.scale: 0.4` against the same 64×64 native frame size, which
    resolves to 25.6×25.6px — i.e. **exact parity with the player's old
    on-screen size**. This strongly suggests `0.72` was an oversight rather
    than an intentional resize — `0.4` (matching the enemy convention) would
    have preserved the player's prior on-screen footprint exactly.
  - **Not changed by this session**, per the explicit carve-out: since the
    player is now visibly ~80% larger, the fixed-offset foot anchor
    (`TRAIL_PUFF_FOOT_OFFSET_PX`) and blood-footprint geometry constants (both
    tuned against the old, smaller sprite) will likely look mis-scaled/
    misaligned relative to the new sprite. This is exactly the kind of
    consequence Slice C's carve-out anticipated — left untouched here.
  - **Recommendation for Slice C**: consider correcting `generated.scale` for
    the player entry to `0.4` (or whatever value Slice C's real generated art
    calls for) as part of its first measurement step, rather than treating
    `0.72` as an intentional target size.
- `VERIFY_FULL=1 npm run verify` — 2119/2120 non-flaky tests passed; the single
  failure (`.github/extensions/sprite-editor/tests/renderer.test.mjs`, "stale
  scaling results cannot overwrite a mid-flight edit") is a pre-existing,
  timing-sensitive flake in an unrelated tooling extension — confirmed passing
  29/29 in isolation, not touched by this diff.
- Targeted vitest suite (6 files covering schema, preload, animation
  registration, PhaserBridge sprite-kind, PhaserBridge, and the hard-gate test)
  — 180/180 passed after the final flip-fix commit.

## Unresolved issues

None blocking. Non-blocking suggestions from plan review (velocity-threshold
jitter smoothing, stale-config handling on animation re-registration, extracting
a shared flip-derivation helper for player/enemy, a dedicated player switch
case instead of a branch inside `default:`) were judged acceptable follow-ups
for this slice and not required for this PR.

## Recommended next steps

- Slice B lands generated multi-frame player-walk art through the same
  `animation` descriptor; once merged, the placeholder sheet here should be
  swapped for the generated one (no engine changes expected).
- Consider extracting the enemy/player flip-derivation logic into one shared
  helper (noted as non-blocking in plan review) if a third animated-entity type
  is added later.

## Systems touched

sprite-pipeline, devtools
