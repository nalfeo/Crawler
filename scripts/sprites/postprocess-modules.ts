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
  cropRectWithMargin,
  type OpaqueRect,
} from './postprocess.js';
import { resizeSpriteStrategy } from './size-variants.js';
import {
  BACKGROUND_B_COLOR_TOLERANCE_SQ,
  BACKGROUND_B_FRINGE_TOLERANCE_SQ,
} from './postprocess-constants.js';

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

function normalizeTolerance(userValue: number | undefined, defaultValue: number): number {
  if (userValue === undefined) return defaultValue;
  if (!Number.isFinite(userValue)) return defaultValue;
  const normalized = Math.round(userValue);
  return normalized >= 0 ? normalized : defaultValue;
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
  /**
   * When set (for frame-sequence briefs), `transparent-trim` uses this
   * pre-computed union bounding box instead of per-frame tight-bbox detection.
   * Ensures every frame in the ordered cycle shares the same crop-to-canvas
   * mapping (identical scale factor and floor-line placement).
   */
  readonly sharedCropRect?: OpaqueRect;
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

    if (ctx.sharedCropRect) {
      // Frame-sequence brief: crop every frame to the pre-computed union bbox
      // so all poses share the same crop-to-canvas mapping. A per-frame
      // independent bbox would give each pose its own scale factor (striding
      // poses are wider than standing ones), breaking the uniform scale and
      // floor-line the animation strip requires.
      const { left, top, right, bottom } = ctx.sharedCropRect;
      const contentW = Math.max(0, right - left + 1);
      const contentH = Math.max(0, bottom - top + 1);
      if (contentW === 0 || contentH === 0) {
        ctx.pushStep('transparent-trim', 'Transparent trim (skipped, empty union bbox)', image);
        return image;
      }
      const normalizedMarginFraction =
        Number.isFinite(marginFraction) && marginFraction > 0 ? marginFraction : 0;
      const normalizedMinMarginPx =
        Number.isFinite(minMarginPx) && minMarginPx > 0 ? Math.trunc(minMarginPx) : 0;
      const marginPx = Math.max(
        normalizedMinMarginPx,
        Math.round(Math.max(contentW, contentH) * normalizedMarginFraction),
      );
      const result = cropRectWithMargin(image, ctx.sharedCropRect, marginPx);
      ctx.pushStep(
        'transparent-trim',
        `Transparent trim (${marginPx}px margin, shared union bbox ${contentW}x${contentH})`,
        result,
      );
      return result;
    }

    const tightlyTrimmed = trimTransparentEdges(image);
    if (tightlyTrimmed.width > 0 && tightlyTrimmed.height > 0) {
      const normalizedMarginFraction =
        Number.isFinite(marginFraction) && marginFraction > 0 ? marginFraction : 0;
      const normalizedMinMarginPx =
        Number.isFinite(minMarginPx) && minMarginPx > 0 ? Math.trunc(minMarginPx) : 0;
      const marginPx = Math.max(
        normalizedMinMarginPx,
        Math.round(
          Math.max(tightlyTrimmed.width, tightlyTrimmed.height) * normalizedMarginFraction,
        ),
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
    const strategy = resizeSpriteStrategy(ctx.brief.type, targetW, targetH);
    const fitResize = fitWithinNearest(image, targetW, targetH, strategy);
    const mode = strategy === 'stretch' ? 'nearest-stretch' : 'nearest-fit';

    ctx.pushStep(
      'resize-nearest',
      `Resize (${mode}, ${fitResize.fittedWidth}x${fitResize.fittedHeight} in ${fitResize.image.width}x${fitResize.image.height})`,
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

    const dropEdgeOrphans =
      mode === 'edge-drop'
        ? true
        : mode === 'preserve-orphans'
          ? false
          : (params.dropEdgeOrphans as boolean);

    const result = removeIsolatedNearWhiteSpeckles(image, {
      minChannel: (params.minChannel as number) ?? 245,
      maxOpaqueNeighbors: (params.maxOpaqueNeighbors as number) ?? 8,
      dropEdgeOrphans,
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
