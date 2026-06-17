import {
  alphaBinary,
  anchorOpaque,
  decodeSprite,
  dimensionsExact,
  opaqueBboxFits,
  opaqueBboxFitsWithOptions,
  opaqueRatio,
  paletteMembership,
} from './sensors/common.js';
import {
  ANCHOR_DERIVABLE_SENSOR,
  anchorDerivable,
  isAnchorDerivableOk,
} from './sensors/anchor-derivable.js';
import {
  ANCHOR_CENTER_OF_MASS_SENSOR,
  anchorCenterOfMass,
} from './sensors/center-of-mass-anchor.js';
import { silhouetteOrientationAxis, weaponSensors } from './sensors/weapons.js';
/**
 * Score one post-processed PNG against its brief.
 *
 * The sensor option overrides on the brief (`brief.sensors`) are merged here
 * with sensor defaults. This is the only place those overrides are consumed,
 * so individual sensors stay simple and the merging policy is one read.
 */
export function scoreCandidate(processedPng, brief, palette) {
  const image = decodeSprite(processedPng);
  const breakdown = [];
  // Universal sensors. opaqueRatio honors the brief override; the anchor
  // sensor is swapped between `anchor-opaque` (static brief pixel) and
  // `anchor-derivable` (derived per variant) based on `brief.sensors.anchor`.
  for (const result of runUniversal(image, brief, palette)) {
    breakdown.push(result);
  }
  // Family-specific sensors.
  if (brief.type === 'weapon') {
    const opts = brief.sensors.weapon ?? {};
    for (const result of weaponSensors(image, {
      diagonalToleranceDeg: opts.diagonalToleranceDeg,
      orientation: opts.orientation,
    })) {
      breakdown.push(result);
    }
  } else if (brief.type === 'enemy' || brief.type === 'character') {
    const facing = brief.sensors.enemy?.facing ?? 'front';
    const toleranceDeg = brief.sensors.enemy?.toleranceDeg;
    if (facing === 'front') {
      breakdown.push(
        silhouetteOrientationAxis(image, {
          orientation: 'vertical',
          toleranceDeg,
        }),
      );
    }
  }
  const score = breakdown.filter((r) => r.ok).length;
  const outOf = breakdown.length;
  // Lift the derived anchor out of the breakdown so consumers don't have to
  // know which slot it occupies. Null when the active anchor sensor failed or
  // when the brief uses the legacy anchor-opaque sensor.
  let derivedAnchor = null;
  for (const result of breakdown) {
    if (isAnchorDerivableOk(result) || isAnchorCenterOfMassOk(result)) {
      derivedAnchor = result.anchor;
      break;
    }
  }
  const derivedHold = deriveHoldAnchor(image, brief);
  const derivedCenterOfGravity = deriveCenterOfGravityAnchor(image);
  return {
    score,
    outOf,
    passed: score === outOf,
    breakdown,
    derivedAnchor: derivedHold ?? derivedAnchor,
    derivedAnchors: {
      hold: derivedHold ?? derivedAnchor,
      centerOfGravity: derivedCenterOfGravity,
    },
  };
}
/**
 * Run universal sensors with brief overrides applied to the ones that accept
 * options. Returns results in the same canonical order as the legacy
 * `universalSensors()` helper, but with the anchor slot swapped to
 * `anchor-derivable` when the brief opts in via `sensors.anchor.derive`.
 */
function runUniversal(image, brief, palette) {
  return [
    dimensionsExact(image, brief),
    alphaBinary(image),
    resolvePaletteMembership(image, brief, palette),
    resolveOpaqueBboxFits(image, brief),
    resolveOpaqueRatio(image, brief),
    resolveAnchorSensor(image, brief),
  ];
}
function resolvePaletteMembership(image, brief, palette) {
  if (brief.postprocessing?.paletteMode !== 'strict') {
    return { ok: true, sensor: 'palette-membership' };
  }
  return paletteMembership(image, palette);
}
function resolveOpaqueBboxFits(image, brief) {
  const edge = brief.sensors.edge;
  if (!edge) return opaqueBboxFits(image);
  return opaqueBboxFitsWithOptions(image, {
    allowMainTouch: edge.allowMainTouch,
    allowDetachedEdgeComponents: edge.allowDetachedEdgeComponents,
    maxDetachedEdgePixels: edge.maxDetachedEdgePixels,
  });
}
function resolveOpaqueRatio(image, brief) {
  const overrides = brief.sensors.opaqueRatio;
  const min = overrides?.min;
  const max = overrides?.max ?? (brief.postprocessing?.trimAndFit ? 0.92 : undefined);
  if (min === undefined && max === undefined) {
    return opaqueRatio(image);
  }
  return opaqueRatio(image, { min, max });
}
function resolveAnchorSensor(image, brief) {
  const anchorOpts = brief.sensors.anchor;
  if (anchorOpts?.mode === 'center-of-mass') {
    return anchorCenterOfMass(image);
  }
  if (anchorOpts?.derive || anchorOpts?.mode === 'grip') {
    return anchorDerivable(image, {
      bandRows: anchorOpts.bandRows,
      centerToleranceX: anchorOpts.centerToleranceX,
    });
  }
  return anchorOpaque(image, brief);
}
function isAnchorCenterOfMassOk(result) {
  if (!result.ok || result.sensor !== ANCHOR_CENTER_OF_MASS_SENSOR) return false;
  const candidate = result;
  if (typeof candidate.anchor !== 'object' || candidate.anchor === null) return false;
  const a = candidate.anchor;
  return typeof a.x === 'number' && typeof a.y === 'number';
}
function deriveHoldAnchor(image, brief) {
  const anchorOpts = brief.sensors.anchor;
  const result = anchorDerivable(image, {
    bandRows: anchorOpts?.bandRows,
    centerToleranceX: anchorOpts?.centerToleranceX,
  });
  return isAnchorDerivableOk(result) ? result.anchor : null;
}
function deriveCenterOfGravityAnchor(image) {
  const result = anchorCenterOfMass(image);
  return isAnchorCenterOfMassOk(result) ? result.anchor : null;
}
export { ANCHOR_DERIVABLE_SENSOR, ANCHOR_CENTER_OF_MASS_SENSOR };
//# sourceMappingURL=score-candidate.js.map
