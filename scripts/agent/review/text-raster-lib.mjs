const INTEGER_EPSILON = 0.001;
const STRONG_EDGE_DELTA = 48;
const SOFT_EDGE_DELTA = 12;
// Calibrated against the locally loaded Press Start 2P equipment capture at
// 1280×720. Canvas text is anti-aliased, so its edge profile is not binary; the
// lower bound rejects softened/interpolated fixture crops without misclassifying
// every valid small glyph as blur.
const CALIBRATED_MINIMUM_CRISPNESS = 0.1;

function isInteger(value) {
  return Number.isFinite(value) && Math.abs(value - Math.round(value)) <= INTEGER_EPSILON;
}

function luminance(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function pixelLuminance(pixels, width, x, y) {
  const offset = (y * width + x) * 4;
  return luminance(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0);
}

/**
 * Measure whether transitions in a text crop are concentrated into sharp edges.
 * It is deliberately local to a declared glyph crop: image-wide sharpness scores
 * are polluted by sprites, panels, and intentionally soft background effects.
 */
export function measureCropCrispness({ pixels, width, height }) {
  if (!(pixels instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('text crop requires RGBA pixels and integer dimensions');
  }
  if (width < 2 || height < 2 || pixels.length < width * height * 4) {
    return { score: 0, strongEdges: 0, softEdges: 0, sampledEdges: 0 };
  }

  let strongEdges = 0;
  let softEdges = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = pixelLuminance(pixels, width, x, y);
      const neighbors = [];
      if (x + 1 < width) neighbors.push(pixelLuminance(pixels, width, x + 1, y));
      if (y + 1 < height) neighbors.push(pixelLuminance(pixels, width, x, y + 1));
      for (const neighbor of neighbors) {
        const delta = Math.abs(source - neighbor);
        if (delta >= STRONG_EDGE_DELTA) strongEdges += 1;
        else if (delta >= SOFT_EDGE_DELTA) softEdges += 1;
      }
    }
  }
  const sampledEdges = strongEdges + softEdges;
  return {
    score: sampledEdges === 0 ? 0 : strongEdges / sampledEdges,
    strongEdges,
    softEdges,
    sampledEdges,
  };
}

/**
 * Converts scene-space bounds to the captured screenshot's pixel space.
 * `rect` is the browser canvas origin, `scale*` maps scene pixels through its
 * CSS transform, and `offset*` accounts for an optional screenshot clip.
 */
export function toScreenshotRasterGeometry({
  bounds,
  rect,
  scaleX,
  scaleY,
  offsetX = 0,
  offsetY = 0,
  containerScale,
}) {
  return {
    rasterX: rect.x + bounds.x * scaleX - offsetX,
    rasterY: rect.y + bounds.y * scaleY - offsetY,
    rasterScaleX: containerScale * scaleX,
    rasterScaleY: containerScale * scaleY,
  };
}

/**
 * Convert captured text-run metadata into a deterministic report. Runs must
 * expose post-transform values: checking authored coordinates alone misses blur
 * introduced by a fractional container transform.
 */
export function evaluateTextRasterRuns(
  runs,
  { minimumCrispness = CALIBRATED_MINIMUM_CRISPNESS } = {},
) {
  if (!Array.isArray(runs)) throw new Error('text raster runs must be an array');
  if (!(minimumCrispness > 0 && minimumCrispness <= 1)) {
    throw new Error('minimum crispness must be in (0, 1]');
  }

  const entries = runs.map((run, index) => {
    const id = typeof run?.id === 'string' && run.id.trim() ? run.id.trim() : `text:${index}`;
    const alignmentValues = [
      run?.rasterX,
      run?.rasterY,
      run?.rasterScaleX,
      run?.rasterScaleY,
      run?.resolution,
    ];
    const aligned = alignmentValues.every(isInteger);
    const loaded = run?.fontLoaded === true;
    const crispness = Number(run?.crispness);
    const cropHasEdges = Number(run?.sampledEdges) > 0;
    const crisp = cropHasEdges && Number.isFinite(crispness) && crispness >= minimumCrispness;
    const failures = [];
    if (!loaded) failures.push('intended font is not loaded');
    if (!aligned) failures.push('text raster geometry is not integer-aligned');
    if (!cropHasEdges) failures.push('text crop has no measurable glyph edges');
    else if (!crisp)
      failures.push(`crop crispness ${crispness.toFixed(3)} is below ${minimumCrispness}`);
    return {
      id,
      text: typeof run?.text === 'string' ? run.text : '',
      fontFamily: typeof run?.fontFamily === 'string' ? run.fontFamily : '',
      rasterX: Number.isFinite(Number(run?.rasterX)) ? Number(run.rasterX) : null,
      rasterY: Number.isFinite(Number(run?.rasterY)) ? Number(run.rasterY) : null,
      rasterScaleX: Number.isFinite(Number(run?.rasterScaleX)) ? Number(run.rasterScaleX) : null,
      rasterScaleY: Number.isFinite(Number(run?.rasterScaleY)) ? Number(run.rasterScaleY) : null,
      resolution: Number.isFinite(Number(run?.resolution)) ? Number(run.resolution) : null,
      loaded,
      aligned,
      crispness: Number.isFinite(crispness) ? crispness : null,
      sampledEdges: Number.isFinite(Number(run?.sampledEdges)) ? Number(run.sampledEdges) : 0,
      failures,
      pass: failures.length === 0,
    };
  });
  return {
    schemaVersion: 1,
    minimumCrispness,
    passed: entries.length > 0 && entries.every((entry) => entry.pass),
    entries,
    failures: entries.flatMap((entry) =>
      entry.failures.map((failure) => `${entry.id}: ${failure}`),
    ),
  };
}

export function isFuzzinessFinding(value) {
  if (typeof value !== 'string') return false;
  if (/\bsharper\s+(?:font|text)\b/i.test(value)) return true;
  const blur = /\b(?:fuzz(?:y|iness)|blurr?(?:y|ed|iness)|soft(?:ened)?)\b/i.test(value);
  const textSubject = /\b(?:text|font|glyph|label|type|rasterization)\b/i.test(value);
  return blur && textSubject;
}

/**
 * Azure is useful for hierarchy critique, but it cannot overrule pixel-grounded
 * evidence about declared text. Preserve non-fuzziness findings unchanged.
 */
export function suppressUnsupportedFuzziness(result, report) {
  if (!report?.passed || !result || typeof result !== 'object') return 0;
  let suppressed = 0;
  const preserveNonFuzzinessClauses = (finding) =>
    finding
      .split(/\s*(?:;|,?\s+\b(?:and|but)\b)\s*/i)
      .filter((clause) => clause && !isFuzzinessFinding(clause))
      .join('; ');
  for (const field of ['blocking_findings', 'recommended_fixes']) {
    if (!Array.isArray(result[field])) continue;
    result[field] = result[field]
      .map((finding) => {
        if (!isFuzzinessFinding(finding)) return finding;
        const preserved = preserveNonFuzzinessClauses(finding);
        suppressed += 1;
        return preserved;
      })
      .filter(Boolean);
  }
  const axes = result.axes;
  if (axes && typeof axes === 'object') {
    for (const axis of ['readability', 'typography_clarity']) {
      const candidate = axes[axis];
      if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.issues)) continue;
      candidate.issues = candidate.issues
        .map((finding) => {
          if (!isFuzzinessFinding(finding)) return finding;
          const preserved = preserveNonFuzzinessClauses(finding);
          suppressed += 1;
          return preserved;
        })
        .filter(Boolean);
    }
  }
  return suppressed;
}
