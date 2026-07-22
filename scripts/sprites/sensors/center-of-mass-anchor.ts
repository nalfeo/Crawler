/**
 * `anchor-center-of-mass` sensor.
 *
 * Derives the anchor from the centroid of the opaque silhouette. This is the
 * right contract for mobs and most non-held sprites: the anchor should sit at
 * the sprite's visual center of mass rather than at a grip or bottom contact
 * point.
 */

import { gatherOpaquePixels, type RgbaImage, type SensorResult } from './common.js';

export const ANCHOR_CENTER_OF_MASS_SENSOR = 'anchor-center-of-mass';

export type CenterOfMassAnchorResult =
  (SensorResult & { ok: true; anchor: { x: number; y: number } }) | (SensorResult & { ok: false });

export function anchorCenterOfMass(image: RgbaImage): CenterOfMassAnchorResult {
  const opaque = gatherOpaquePixels(image);
  if (opaque.length === 0) {
    return {
      ok: false,
      sensor: ANCHOR_CENTER_OF_MASS_SENSOR,
      reason: 'no opaque pixels in image',
    };
  }
  let sumX = 0;
  let sumY = 0;
  for (const p of opaque) {
    sumX += p.x;
    sumY += p.y;
  }
  const centerX = sumX / opaque.length;
  const centerY = sumY / opaque.length;
  let best = opaque[0]!;
  let bestDist = distanceSquared(best.x, best.y, centerX, centerY);
  for (let i = 1; i < opaque.length; i++) {
    const p = opaque[i]!;
    const dist = distanceSquared(p.x, p.y, centerX, centerY);
    if (
      dist < bestDist ||
      (dist === bestDist && (p.y < best.y || (p.y === best.y && p.x < best.x)))
    ) {
      best = p;
      bestDist = dist;
    }
  }
  return {
    ok: true,
    sensor: ANCHOR_CENTER_OF_MASS_SENSOR,
    anchor: { x: best.x, y: best.y },
  };
}

function distanceSquared(x: number, y: number, cx: number, cy: number): number {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy;
}
