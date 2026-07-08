/**
 * Honest render-readiness gate for the set-piece lab.
 *
 * The headless visual-review harness (`scripts/agent/review/visual-review-agent.ts`)
 * screenshots the lab only after `window.__uiProbe.ready()` returns `true`. On a
 * COLD browser cache the lab's generated PNGs are not yet resident when the scene
 * first renders, so the very first `PhaserBridge.sync()` draws grey placeholder
 * Rectangles (props whose textures have not loaded) and villager-fallback NPC
 * sprites instead of the real art. If `ready()` flips `true` on the mere
 * completion of the sprite-warm promise, the agent captures those placeholders
 * (~199KB PNG) instead of the real room (~376-460KB PNG) — an intermittent,
 * cold-cache-only capture bug.
 *
 * This module isolates the *decision* — given a snapshot of what is actually on
 * the Phaser display list right now, is the current set piece rendering REAL
 * art? — as a pure function so it can be unit-tested without a browser. The lab
 * recomputes these counts after every per-frame `bridge.sync()` and feeds them
 * here, so a later sync that upgrades placeholder Rectangles to real Images (and
 * villager NPC sprites to their pinned generated keys) flips `ready` `true`
 * honestly rather than optimistically.
 *
 * This is a HARNESS/CAPTURE-TIMING concern only; it deliberately does not touch
 * gameplay, the bridge, or set-piece rendering.
 */

/** A snapshot of the set-piece scene's display list, reduced to the counts that
 *  decide whether real art is on screen. */
export interface SetPieceRenderCounts {
  /**
   * Number of set-piece prop placeholder Rectangles currently on the display
   * list. A resolved prop is an Image; the bridge destroys the placeholder
   * Rectangle and creates an Image once the texture loads, so any Rectangle
   * remaining means at least one prop texture is still unresolved (cold cache).
   *
   * SCOPE CAVEAT: this counts the standard set-piece placeholder path, where an
   * unresolved prop renders as a grey Rectangle. It does NOT generically catch a
   * custom-art prop that renders an unresolved fallback as an *Image* (the
   * `ref.placeholder` path in the bridge) — for such a prop `placeholderRectCount`
   * would read 0 while placeholder art is still on screen. The only surface this
   * gate is validated against — Floor-1 welcome-room — uses the Rectangle path
   * for every prop (confirmed by cold-cache capture: 14 → 0 Rectangles as the
   * generated textures resolve), so the count is exact here. A future piece built
   * from custom placeholder Images would need the gate strengthened to track
   * expected per-prop final textures rather than GameObject-type counts.
   */
  readonly placeholderRectCount: number;
  /**
   * Total number of Image GameObjects on the display list (resolved props +
   * NPCs). Guards the pre-sync empty scene: zero images means nothing has
   * rendered yet, so `placeholderRectCount === 0` must not be read as "ready".
   */
  readonly imageCount: number;
  /**
   * Number of distinct pinned generated NPC texture keys this set piece
   * requires (e.g. welcome-room needs 3: goon, merchant, spell-broker). Zero for
   * a piece with no NPCs that pin a generated key.
   */
  readonly requiredNpcKeyCount: number;
  /**
   * How many of the required NPC keys are currently resident as an on-screen
   * Image texture. Until this reaches `requiredNpcKeyCount`, at least one NPC is
   * still showing its villager fallback sprite.
   */
  readonly resolvedNpcKeyCount: number;
}

/**
 * Decide whether the set-piece lab is showing REAL art for the current piece.
 *
 * Ready iff ALL of the following hold:
 *  1. at least one Image has rendered (liveness — not the pre-sync empty scene),
 *  2. zero placeholder Rectangles remain (every prop resolved to real art), AND
 *  3. every required pinned NPC key is resident (no villager fallbacks left).
 *
 * A piece with no required NPC keys is ready on (1)+(2) alone. A piece that
 * requires NPC keys never flips ready until they all resolve — which is loud and
 * correct: the only reviewed piece, welcome-room, has 3 pinned NPC keys, and a
 * capture missing any of them would show a villager fallback.
 */
export function isSetPieceRenderReady(counts: SetPieceRenderCounts): boolean {
  const { placeholderRectCount, imageCount, requiredNpcKeyCount, resolvedNpcKeyCount } = counts;
  if (imageCount <= 0) {
    return false;
  }
  if (placeholderRectCount > 0) {
    return false;
  }
  if (resolvedNpcKeyCount < requiredNpcKeyCount) {
    return false;
  }
  return true;
}
