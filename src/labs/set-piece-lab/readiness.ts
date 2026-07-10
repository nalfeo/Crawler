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

import type { SpriteRef } from '../../shared/set-piece-types.js';

/**
 * Does this layer's sprite render as a PERMANENT placeholder Rectangle — one that
 * will never resolve to real art no matter how long we wait?
 *
 * The bridge's `resolveSetPieceSprite` returns `null` (→ a grey Rectangle) for a
 * `custom` ref that has no `placeholder` fallback, and there is no bespoke-asset
 * path that can later fill it in, so such a prop stays a Rectangle for the life of
 * the scene. That is INTENTIONAL — an honest "art queued, not yet generated"
 * stand-in (see `collectCustomArtRequests`) — and must NOT be mistaken for a
 * still-loading cold-cache placeholder by the readiness gate.
 *
 * Every other ref (catalog, sheet, or a custom ref WITH a placeholder chain)
 * either resolves to an Image or is merely TRANSIENTLY a Rectangle until its
 * texture loads, so it is excluded here — the gate must keep waiting on those.
 */
export function spriteRefRendersPersistentPlaceholder(ref: SpriteRef): boolean {
  return ref.source === 'custom' && ref.placeholder === undefined;
}

/** A snapshot of the set-piece scene's display list, reduced to the counts that
 *  decide whether real art is on screen. */
export interface SetPieceRenderCounts {
  /**
   * Number of set-piece prop placeholder Rectangles currently on the display
   * list. A resolved prop is an Image; the bridge destroys the placeholder
   * Rectangle and creates an Image once the texture loads, so any Rectangle
   * remaining ABOVE the expected persistent count means at least one prop texture
   * is still unresolved (cold cache).
   *
   * SCOPE NOTE: this counts the standard set-piece placeholder path, where an
   * unresolved prop renders as a grey Rectangle. INTENTIONAL, forever-unresolved
   * placeholders (a `custom` ref with no `placeholder` fallback — honest "art
   * queued" stand-ins) are also Rectangles but must not block readiness; they are
   * accounted for by {@link SetPieceRenderCounts.expectedPersistentPlaceholderCount}
   * (see {@link spriteRefRendersPersistentPlaceholder}). It still does NOT catch a
   * custom-art prop that renders an unresolved fallback as an *Image* (the
   * `ref.placeholder` path in the bridge) — for such a prop `placeholderRectCount`
   * would read 0 while placeholder art is on screen; no currently-reviewed piece
   * uses that path.
   */
  readonly placeholderRectCount: number;
  /**
   * How many placeholder Rectangles are EXPECTED to remain permanently for the
   * current piece — one per prop layer whose sprite renders a persistent
   * placeholder (see {@link spriteRefRendersPersistentPlaceholder}). The gate
   * treats the piece as prop-ready once `placeholderRectCount` has fallen to at
   * most this many (every TRANSIENT cold-cache rect resolved; only the intentional
   * queued-art stand-ins are left). Defaults to 0 — a piece with no custom
   * placeholder props must still resolve every Rectangle.
   */
  readonly expectedPersistentPlaceholderCount?: number;
  /**
   * Total number of Image GameObjects on the display list (resolved props +
   * NPCs). Combined with {@link SetPieceRenderCounts.placeholderRectCount} it
   * guards the pre-sync empty scene: only when BOTH are zero has nothing rendered
   * yet, so `placeholderRectCount === 0` alone must not be read as "ready".
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
 *  1. the scene has actually rendered SOMETHING (liveness — not the pre-sync empty
 *     scene): at least one Image OR at least one placeholder Rectangle is on the
 *     display list,
 *  2. no MORE than the expected persistent count of placeholder Rectangles remain
 *     — i.e. every transient cold-cache rect resolved, leaving at most the
 *     intentional queued-art stand-ins, AND
 *  3. every required pinned NPC key is resident (no villager fallbacks left).
 *
 * A piece with no required NPC keys is ready on (1)+(2) alone. A piece that
 * requires NPC keys never flips ready until they all resolve — which is loud and
 * correct: the only reviewed piece, welcome-room, has 3 pinned NPC keys, and a
 * capture missing any of them would show a villager fallback.
 *
 * The liveness guard keys off `imageCount === 0 && placeholderRectCount === 0`
 * rather than `imageCount <= 0` so a PURE-placeholder piece (all layers are
 * intentional queued-art stand-ins, zero resolvable Images) still flips ready once
 * its Rectangles render, instead of hanging the harness forever. The transient
 * cold-cache case is still caught by guard (2): while real props are mid-load,
 * `placeholderRectCount` exceeds `expectedPersistentPlaceholderCount`.
 */
export function isSetPieceRenderReady(counts: SetPieceRenderCounts): boolean {
  const {
    placeholderRectCount,
    imageCount,
    requiredNpcKeyCount,
    resolvedNpcKeyCount,
    expectedPersistentPlaceholderCount = 0,
  } = counts;
  if (imageCount === 0 && placeholderRectCount === 0) {
    return false;
  }
  if (placeholderRectCount > expectedPersistentPlaceholderCount) {
    return false;
  }
  if (resolvedNpcKeyCount < requiredNpcKeyCount) {
    return false;
  }
  return true;
}
