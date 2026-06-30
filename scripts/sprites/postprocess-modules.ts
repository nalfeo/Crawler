/**
 * Post-processing pipeline modules.
 *
 * Each module is a pure function:
 *   (image, brief, palette, params) => RgbaImage
 *
 * Modules are the pluggable processing units that compose into pipelines
 * via templates. They accumulate trace steps via a provided callback.
 */

import type { Brief, PaletteColors } from './brief-schema.js';
import {
  removeBackgroundB,
  removeEnclosedBackgroundRegions,
  removeReintroducedBackground,
  removeIsolatedNearWhiteSpeckles,
  quantizeToPalette,
  hardThresholdAlpha,
  trimTransparentEdges,
  fitWithinNearest,
  scaleToMinDimension,
} from './postprocess.js';

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const BACKGROUND_B_COLOR_TOLERANCE_SQ = 3 * 255 * 255 * 0.2; // ~15 per channel
const BACKGROUND_B_FRINGE_TOLERANCE_SQ = 3 * 255 * 255 * 0.06; // ~5 per channel

function normalizeTolerance(userValue: number | undefined, defaultValue: number): number {
  if (userValue === undefined) return defaultValue;
  if (userValue < 0) return 0;
  return userValue;
}

/**
 * Module context: passed to each module handler for logging and side effects.
 */
export interface ModuleContext {
  readonly brief: Brief;
  readonly palette: PaletteColors;
  readonly pushStep: (id: string, label: string, image: RgbaImage) => void;
  readonly backgroundSource?: RgbaImage;
  readonly shouldRunEnclosedBackgroundCleanup?: boolean;
}

export type ModuleHandler = (
  image: RgbaImage,
  params: Record<string, unknown>,
  ctx: ModuleContext,
) => RgbaImage;

export const postprocessModules: Record<string, ModuleHandler> = {
  'background-removal': (image, params, ctx) => {
    const userColorToleranceSq = (params.colorToleranceSq as number) ?? undefined;
    const userFringeToleranceSq = (params.fringeToleranceSq as number) ?? undefined;

    const colorToleranceSq = normalizeTolerance(
      userColorToleranceSq,
      BACKGROUND_B_COLOR_TOLERANCE_SQ,
    );
    const fringeToleranceSq = normalizeTolerance(
      userFringeToleranceSq,
      BACKGROUND_B_FRINGE_TOLERANCE_SQ,
    );

    const result = removeBackgroundB(image, {
      colorToleranceSq,
      fringeToleranceSq,
      clearEnclosedIslands: false,
    });

    ctx.pushStep('background-removal', 'Background removal', result);
    return result;
  },

  'enclosed-region-cleanup': (image, params, ctx) => {
    if (!ctx.backgroundSource || !ctx.shouldRunEnclosedBackgroundCleanup) {
      ctx.pushStep(
        'background-enclosed-regions-disabled',
        'Background enclosed-region cleanup (disabled)',
        image,
      );
      return image;
    }

    const fringeToleranceSq = normalizeTolerance(
      (params.fringeToleranceSq as number) ?? undefined,
      BACKGROUND_B_FRINGE_TOLERANCE_SQ,
    );

    const result = removeEnclosedBackgroundRegions(image, ctx.backgroundSource, fringeToleranceSq);
    ctx.pushStep('background-enclosed-regions', 'Background enclosed-region cleanup', result);
    return result;
  },

  'transparent-trim': (image, params, ctx) => {
    const marginFraction = (params.marginFraction as number) ?? 0.06;
    const minMarginPx = (params.minMarginPx as number) ?? 1;

    const tightlyTrimmed = trimTransparentEdges(image);
    if (tightlyTrimmed.width > 0 && tightlyTrimmed.height > 0) {
      const marginFraction_ = marginFraction > 0 ? marginFraction : Math.max(1, minMarginPx);
      const marginPx = Math.max(
        minMarginPx,
        Math.floor(Math.max(tightlyTrimmed.width, tightlyTrimmed.height) * marginFraction_),
      );
      const result = trimTransparentEdges(tightlyTrimmed, marginPx);
      ctx.pushStep('transparent-trim', `Transparent trim (${marginPx}px margin)`, result);
      return result;
    }

    ctx.pushStep('transparent-trim', 'Transparent trim (skipped, empty)', image);
    return image;
  },

  'resize-nearest': (image, _params, ctx) => {
    const { width: targetW, height: targetH } = ctx.brief.size;
    const fitResize = fitWithinNearest(image, targetW, targetH);

    ctx.pushStep(
      'resize-nearest',
      `Resize (nearest-fit, ${fitResize.fittedWidth}x${fitResize.fittedHeight} in ${fitResize.image.width}x${fitResize.image.height})`,
      fitResize.image,
    );

    return fitResize.image;
  },

  'background-rekey': (image, params, ctx) => {
    if (!ctx.backgroundSource) {
      ctx.pushStep('background-rekey-skipped', 'Background re-removal (skipped, no source)', image);
      return image;
    }

    const fringeToleranceSq = normalizeTolerance(
      (params.fringeToleranceSq as number) ?? undefined,
      BACKGROUND_B_FRINGE_TOLERANCE_SQ,
    );

    const result = removeReintroducedBackground(image, ctx.backgroundSource, {
      fringeToleranceSq,
      clearEnclosedIslands: ctx.shouldRunEnclosedBackgroundCleanup ?? false,
    });

    ctx.pushStep('background-rekey', 'Background re-removal (post-resize)', result);
    return result;
  },

  'speckle-cleanup': (image, params, ctx) => {
    const mode = (params.mode as string) ?? 'edge-drop';
    if (mode === 'disabled') {
      ctx.pushStep('speckle-cleanup-disabled', 'Speckle cleanup (disabled)', image);
      return image;
    }

    const result = removeIsolatedNearWhiteSpeckles(image, {
      minChannel: (params.minChannel as number) ?? 245,
      maxOpaqueNeighbors: (params.maxOpaqueNeighbors as number) ?? 8,
      dropEdgeOrphans: mode === 'edge-drop' ? true : (params.dropEdgeOrphans as boolean),
    });

    ctx.pushStep('speckle-cleanup', `Speckle cleanup (${mode})`, result);
    return result;
  },

  'palette-quantize': (image, _params, ctx) => {
    if (ctx.brief.postprocessing?.paletteMode !== 'strict') {
      ctx.pushStep('palette-quantize-skipped', 'Palette quantize (skipped)', image);
      return image;
    }

    const result = quantizeToPalette(image, ctx.palette);
    ctx.pushStep('palette-quantize', 'Palette quantize (strict)', result);
    return result;
  },

  'alpha-threshold': (image, _params, ctx) => {
    const result = hardThresholdAlpha(image);
    ctx.pushStep('alpha-threshold', 'Alpha threshold', result);
    return result;
  },

  'trim-and-fit': (image, params, ctx) => {
    if (!ctx.brief.postprocessing?.trimAndFit) {
      return image;
    }

    const trimmed = trimTransparentEdges(image);
    if (trimmed.width > 0 && trimmed.height > 0) {
      const minDim = (params.minDimension as number) ?? 64;
      const result = scaleToMinDimension(trimmed, minDim);
      ctx.pushStep('trim-fit', `Trim + fit (${minDim}px min)`, result);
      return result;
    }

    return image;
  },
};
