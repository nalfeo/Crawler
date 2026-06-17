/**
 * `anchor-center-of-mass` sensor.
 *
 * Derives the anchor from the centroid of the opaque silhouette. This is the
 * right contract for mobs and most non-held sprites: the anchor should sit at
 * the sprite's visual center of mass rather than at a grip or bottom contact
 * point.
 */
import { type RgbaImage, type SensorResult } from './common.js';
export declare const ANCHOR_CENTER_OF_MASS_SENSOR = 'anchor-center-of-mass';
export type CenterOfMassAnchorResult =
  | (SensorResult & {
      ok: true;
      anchor: {
        x: number;
        y: number;
      };
    })
  | (SensorResult & {
      ok: false;
    });
export declare function anchorCenterOfMass(image: RgbaImage): CenterOfMassAnchorResult;
//# sourceMappingURL=center-of-mass-anchor.d.ts.map
