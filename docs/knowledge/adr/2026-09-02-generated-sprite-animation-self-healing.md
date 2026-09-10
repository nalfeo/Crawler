# ADR: Generated-sprite animation registration self-heals a texture-not-ready race

## Status

Accepted

## Date

2026-09-02

## Estimated Complexity

🍎 x 2 — one floor-agnostic engine defect in the generated-sprite animation
registration path, plus a test-harness fidelity fix required to actually
exercise it.

## Context

- **CTX-001**: The `floor-4-playable-completion` epic requires the visual
  AI-runner lab (`ai-runner-lab` / `MainGameScene`) to complete Floor 4 on
  seed 404 with the production `BehaviorTreeAI`. Selecting a floor/seed
  through the lab's public controls calls `phaserScene.scene.restart()`.
- **CTX-002**: Restarting the scene quickly after page load (as any automated
  driver naturally does, and as the lab UI itself permits) reliably froze the
  render/update loop within 1–16 frames, with an uncaught
  `TypeError: Cannot read properties of undefined (reading 'duration')` inside
  Phaser's `Animation.getFirstTick`, thrown from `MainGameScene.update()`.
  Confirmed floor-agnostic (reproduces on Floor 1 too) and specific to a fast
  `scene.restart()`, not to floor choice or run speed — this made the visual
  runner **unobservable** for Floor 4, independent of any Floor 4 gameplay
  code.
- **CTX-003**: Root-caused against Phaser's real source
  (`node_modules/phaser/src/animations/AnimationManager.js`,
  `Animation.js`, `AnimationState.js`): `AnimationManager#generateFrameNumbers`
  returns `[]` (only a `console.warn`, never a throw) when the requested
  texture is not yet registered in the `TextureManager` — a genuine race
  between the generated sprite's async texture decode and Phaser's synchronous
  scene lifecycle. The project's own `registerGeneratedSpriteAnimations`
  (`src/engine/generatedAssets/animations.ts`) called
  `anims.create({ frames: [], ... })` unconditionally in that case, permanently
  registering a broken zero-frame `Animation` under the walk-cycle key in
  Phaser's **global, per-game** `AnimationManager` — not reset by scene
  restarts, and checked forever afterward via `anims.exists(key)`. The first
  `.play()` call on that poisoned key crashed inside `Animation#getFirstTick`
  (`state.currentFrame` undefined because `frames` was empty).
- **CTX-004**: Confirmed separately that calling `.play()` on a key that was
  **never created at all** is safe in real Phaser:
  `AnimationState.startAnimation` calls `this.load(key)`, and if the key isn't
  registered, the function early-returns without ever setting `isPlaying` or
  reaching `getFirstTick`. This is what makes "skip creating, retry once the
  texture is ready" both correct and safe — the sprite simply doesn't animate
  in the interim, with zero crash risk.
- **CTX-005**: The existing test harness (`tests/fixtures/phaser-bridge-harness.ts`)
  did not model this race at all: its `MockAnimationManager.generateFrameNumbers`
  always returned a full frame array, and `MockAnimationState.play()` did not
  check `manager.exists(key)` first (unlike real Phaser's `startAnimation`) —
  a naive regression test against the un-fixed mock would have given a false
  pass.

## Decision

1. Add `confirmGeneratedSpriteAnimation(anims, textureKey, animation): boolean`
   to `src/engine/generatedAssets/animations.ts`. It calls
   `anims.generateFrameNumbers(...)` first; if the result is an array and that
   array is empty, it **skips** `anims.create()` entirely (never poisons the
   key) and returns `false`. Otherwise it creates the animation and returns
   `true`. (The `Array.isArray(...) && length === 0` guard — not a bare
   `length === 0` check — is deliberate: existing test stubs return a
   non-array placeholder shape from `generateFrameNumbers`, and those are
   treated as "trust it, proceed to create" so pre-existing tests keep
   passing unchanged.)
2. `registerGeneratedSpriteAnimations` now uses this helper internally and
   only reports genuinely-created/confirmed keys in its returned `keys` list.
3. `PhaserBridge.sync()` tracks a small `pendingAnimationTextures` map
   (populated only for texture keys whose registration didn't succeed yet)
   and retries just those pending keys on every subsequent `sync()` call,
   until they succeed — cheap, since the pending set is normally 0–1 entries,
   avoiding a full ~652-entry sprite-registry rescan every frame.
4. Fixed the test harness to actually model the race:
   `MockAnimationManager` gained `markTextureNotReady(key)` /
   `markTextureReady(key)` gating `generateFrameNumbers`, and
   `MockAnimationState.play()` now checks `manager.exists(key)` before
   flipping `isPlaying`, matching real Phaser.

## Consequences

### Positive

- The visual AI-runner (and any other Phaser scene using generated-sprite
  animations) can now survive a fast scene restart without a permanent
  render-loop freeze — confirmed by re-running the exact fast-restart repro
  against a live dev server: continuous frame advancement from load through a
  full Floor 4 victory, zero page errors, versus the pre-fix permanent freeze.
- The fix is floor-agnostic and touches no gameplay/scenario code — it is a
  correctness fix in the shared animation-registration path, applicable
  identically to every floor and every scene that uses generated sprites.
- Self-healing is bounded and cheap: the retry set is normally 0–1 entries per
  scene, not a background poll of the whole registry.

### Negative

- A sprite's walk animation may visibly not play for the first few frames
  after a fast restart, until the texture finishes loading and the retry
  succeeds. This is strictly better than the prior behavior (permanent crash)
  and is not observable in practice at normal human interaction speed (the
  race window is on the order of single-digit frames).

### Risks

- If a texture key is permanently missing (not merely "not yet loaded" but
  genuinely absent — e.g., an asset-pipeline regression), the pending retry
  will spin forever without ever succeeding or emitting a diagnostic. This
  was true of the pre-fix code's underlying warning path too (Phaser's own
  `console.warn`), so this ADR does not regress diagnosability, but a
  follow-up could add a bounded retry-attempt cap with a one-time error log if
  this becomes an operational blind spot.

## Alternatives Considered

- **Wait before allowing a scene restart** (e.g., gate the lab's "apply"
  button until the previous scene's generated textures are confirmed loaded).
  Rejected: papers over the underlying defect rather than fixing it, would
  still leave a real crash reachable by any other future restart path (not
  just the lab), and does not fix the case where the SAME race occurs on the
  very first scene load (slow network/cold texture decode), not just restarts.
- **Retry-scan the full sprite registry every frame** instead of tracking a
  small pending set. Rejected: unnecessary per-frame cost (~652 entries)
  when the actual pending set is normally 0–1 keys.
- **Throw a catchable error instead of silently skipping.** Rejected: Phaser's
  own `generateFrameNumbers` already treats "texture not ready" as a warning,
  not an error condition; escalating it to a throw would newly crash valid
  slow-load scenarios that previously "worked" only by accident (texture
  finished loading before the very first `.play()` call).
