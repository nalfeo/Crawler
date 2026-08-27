import { resolveOpaqueFit, type OpaqueBounds } from '../../shared/generated-assets.js';

/**
 * stairs-visuals — pure fit logic for the floor-exit staircase marker.
 *
 * The staircase objective used to render as nothing but a plain Phaser
 * `Arc` (a filled circle + stroke). This module lets `MainGameScene` stamp
 * the approved "the-stairs" generated art on top of that footprint instead,
 * following the same pattern as `door-visuals.ts`: a pure, Phaser-free
 * selection/fit helper the renderer maps to a concrete Image, kept
 * unit-testable in isolation.
 *
 * The marker is a floor-plane decal (it depicts a stairwell receding into
 * the ground, not a standing object), so it is CENTRE-anchored and
 * contain-fitted into a square footprint — never floor-anchored like a door
 * or prop.
 */

/**
 * Approved generated texture key for the staircase marker. Auto-loaded at
 * boot under its bare manifest key when the art is approved (see
 * `the-stairs-var-0.json`); if it is ever unapproved the renderer's
 * `this.textures.exists()` check simply fails and the plain circle fallback
 * takes over.
 */
export const STAIRS_TEXTURE_KEY = 'the-stairs-var-0';

/**
 * Resolve the origin + scale that fit the staircase art into a square
 * footprint (`2 * markerRadiusPx` per side), centred on the marker position.
 *
 * Shared with the door contain-fit family: `floorPlane: true` means the art
 * is contain-fitted (never stretched to fill the square), and
 * `anchorBase: false` centres it on the marker position rather than pinning
 * its bottom edge — the marker sits on open floor, not against a wall.
 */
export function resolveStairsContainFit(input: {
  readonly bounds: OpaqueBounds | undefined;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly markerRadiusPx: number;
}) {
  const footprint = input.markerRadiusPx * 2;
  return resolveOpaqueFit({
    bounds: input.bounds,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    targetWidthPx: footprint,
    targetHeightPx: footprint,
    anchorBase: false,
    floorPlane: true,
  });
}
