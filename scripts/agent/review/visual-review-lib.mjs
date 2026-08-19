// @ts-check
/**
 * Pure, unit-tested helpers for the surface-agnostic visual-review "UX judge"
 * (`visual-review-agent.ts`). These functions carry ALL the deterministic
 * geometry/finding math for GENERIC declared surfaces so the browser
 * `page.evaluate` only harvests raw data and Node does the reasoning.
 *
 * IMPORTANT: the legacy EquipmentUI review path does NOT use this module — it
 * keeps its own untouched in-browser `page.evaluate` blocks so its output stays
 * byte-for-byte identical. Everything here is for declared (`window.__visualReview`)
 * surfaces only.
 *
 * All coordinates are DESIGN space (1280x720 Phaser FIT scene), the same space
 * the `window.__uiProbe` bounds are reported in. Callers must not mix CSS pixels.
 *
 * Plain ESM (`.mjs`) with no Node globals so it can be `node --test`'d directly
 * (matches `scripts/agent/review/*.test.mjs`) and imported by the tsx-run agent
 * via the hand-written `visual-review-lib.d.mts`.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} VisualReviewBox
 * @typedef {'slot' | 'icon' | 'panel' | 'tooltip' | 'text' | 'other'} VisualReviewRegionKind
 * @typedef {{ id: string, box: VisualReviewBox, kind?: VisualReviewRegionKind, parentId?: string }} VisualReviewRegion
 * @typedef {{ score: number, raw: unknown, normalized: boolean }} NormalizedScore
 * @typedef {{ new: string[], recurring: string[] }} FindingDiff
 */

/** Kinds that are containers/overlays and must NOT participate in sibling overlap/touch. */
const OVERLAP_EXCLUDED_KINDS = new Set(['panel', 'tooltip', 'icon']);

/**
 * @param {unknown} box
 * @returns {box is VisualReviewBox}
 */
function isValidBox(box) {
  if (!box || typeof box !== 'object') return false;
  const b = /** @type {Record<string, unknown>} */ (box);
  const { x, y, width, height } = b;
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

/**
 * @param {VisualReviewRegion} a
 * @param {VisualReviewRegion} b
 * @returns {string}
 */
function overlapNoun(a, b) {
  return a.kind === 'slot' && b.kind === 'slot' ? 'Slot boxes' : 'Regions';
}

/**
 * Deterministic geometry blockers for a DECLARED generic surface. Reproduces the
 * spirit of the legacy equipment checks (overlap, touch-with-no-breathing-room,
 * icon-escapes-its-box) but keyed on declared region ids so findings are
 * pixel-grounded and reference real elements.
 *
 * - Overlap/touch is computed only between SIBLING content regions (same
 *   `parentId`; regions with no parentId are siblings of each other). Container
 *   and overlay kinds (`panel`, `tooltip`, `icon`) are excluded from this pass.
 * - Touch = zero overlap but gap <= 1px along one axis while sharing >= 8px of
 *   extent on the other (matches the legacy equipment thresholds).
 * - Container overrun = ANY region whose box leaves its declared parent region's
 *   box by more than 1px on any edge. An `icon` reports as the legacy
 *   "Icon escapes its box"; everything else reports the overrun edges + pixels.
 * - Paired-slot alignment = two halves of a pair (`*1`/`*2`, or `left*`/`right*`)
 *   that do not share a row baseline within 1px. See `computeAlignmentBlockers`.
 *
 * Output order is deterministic: overlap/touch pairs in region declaration order
 * (grouped by parent, i<j), then containment in declaration order, then
 * alignment in first-seen pair order.
 *
 * @param {readonly VisualReviewRegion[]} regions
 * @returns {string[]}
 */
export function computeGeometryBlockers(regions) {
  const list = Array.isArray(regions) ? regions : [];
  const valid = list.filter(
    (r) => r && typeof r === 'object' && typeof r.id === 'string' && isValidBox(r.box),
  );
  /** @type {string[]} */
  const blockers = [];

  // 1. Overlap + touch among sibling CONTENT regions, grouped by parentId.
  const content = valid.filter((r) => !OVERLAP_EXCLUDED_KINDS.has(/** @type {string} */ (r.kind)));
  /** @type {Map<string, VisualReviewRegion[]>} */
  const groups = new Map();
  for (const r of content) {
    const key = r.parentId ?? '__root__';
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        const x1 = Math.max(a.box.x, b.box.x);
        const y1 = Math.max(a.box.y, b.box.y);
        const x2 = Math.min(a.box.x + a.box.width, b.box.x + b.box.width);
        const y2 = Math.min(a.box.y + a.box.height, b.box.y + b.box.height);
        const overlapW = Math.max(0, x2 - x1);
        const overlapH = Math.max(0, y2 - y1);
        const overlap = overlapW * overlapH;
        if (overlap > 0) {
          blockers.push(`${overlapNoun(a, b)} overlap: ${a.id} intersects ${b.id}.`);
          continue;
        }
        const horizontalGap = Math.max(
          a.box.x - (b.box.x + b.box.width),
          b.box.x - (a.box.x + a.box.width),
          0,
        );
        const verticalGap = Math.max(
          a.box.y - (b.box.y + b.box.height),
          b.box.y - (a.box.y + a.box.height),
          0,
        );
        const touchesVertically = verticalGap <= 1 && overlapW >= 8;
        const touchesHorizontally = horizontalGap <= 1 && overlapH >= 8;
        if (touchesVertically || touchesHorizontally) {
          blockers.push(
            `${overlapNoun(a, b)} touch with no breathing room: ${a.id} adjacent to ${b.id}.`,
          );
        }
      }
    }
  }

  // 2. Any child region escaping its declared parent box by more than 1px.
  /** @type {Map<string, VisualReviewRegion>} */
  const byId = new Map();
  for (const r of valid) if (!byId.has(r.id)) byId.set(r.id, r);
  for (const r of valid) {
    if (r.parentId === undefined) continue;
    const parent = byId.get(r.parentId);
    if (!parent || parent.id === r.id) continue;
    const t = 1;
    const overflowLeft = parent.box.x - t - r.box.x;
    const overflowTop = parent.box.y - t - r.box.y;
    const overflowRight = r.box.x + r.box.width - (parent.box.x + parent.box.width + t);
    const overflowBottom = r.box.y + r.box.height - (parent.box.y + parent.box.height + t);
    const worst = Math.max(overflowLeft, overflowTop, overflowRight, overflowBottom);
    if (worst <= 0) continue;
    if (r.kind === 'icon') {
      blockers.push(`Icon escapes its box: ${r.id} (outside ${parent.id}).`);
      continue;
    }
    /** @type {string[]} */
    const edges = [];
    if (overflowLeft > 0) edges.push(`left by ${round1(overflowLeft)}px`);
    if (overflowTop > 0) edges.push(`top by ${round1(overflowTop)}px`);
    if (overflowRight > 0) edges.push(`right by ${round1(overflowRight)}px`);
    if (overflowBottom > 0) edges.push(`bottom by ${round1(overflowBottom)}px`);
    blockers.push(
      `Region overruns its container: ${r.id} crosses ${parent.id} ${edges.join(', ')}.`,
    );
  }

  // 3. Paired slots (ring1/ring2, left*/right*) must share a row baseline.
  blockers.push(...computeAlignmentBlockers(valid));

  return blockers;
}

/**
 * Derive a pair identity from a region id, so `slot:ring1` and `slot:ring2` — or
 * `slot:leftWrist` and `slot:rightWrist` — are recognized as two halves of one
 * pair. Returns `{ group, half }` or null when the id is not part of a pair.
 *
 * @param {string} id
 * @returns {{ group: string, half: string } | null}
 */
export function pairIdentity(id) {
  const numbered = /^(.*?)([_-]?)(\d+)$/.exec(id);
  if (numbered && (numbered[3] === '1' || numbered[3] === '2')) {
    return { group: `${numbered[1]}#`, half: numbered[3] };
  }
  const sided = /(left|right)/i.exec(id);
  if (sided) {
    const side = sided[1].toLowerCase();
    return { group: id.replace(/left|right|Left|Right/, '*'), half: side === 'left' ? '1' : '2' };
  }
  return null;
}

/**
 * Paired slots must sit on the same row baseline. A pair whose halves differ in
 * `y` (or in height) by more than 1px is a defect the LLM judge reports
 * inconsistently, so it is measured here instead.
 *
 * Only `slot`-kind regions participate, and only when BOTH halves are present
 * and share a parent, so a lone `ring1` or a cross-panel coincidence never fires.
 *
 * @param {readonly VisualReviewRegion[]} regions
 * @returns {string[]}
 */
export function computeAlignmentBlockers(regions) {
  const slots = (Array.isArray(regions) ? regions : []).filter(
    (r) => r && r.kind === 'slot' && typeof r.id === 'string' && isValidBox(r.box),
  );
  /** @type {Map<string, Map<string, VisualReviewRegion>>} */
  const groups = new Map();
  /** @type {string[]} */
  const order = [];
  for (const slot of slots) {
    const identity = pairIdentity(slot.id);
    if (!identity) continue;
    const key = `${slot.parentId ?? '__root__'}::${identity.group}`;
    let halves = groups.get(key);
    if (!halves) {
      halves = new Map();
      groups.set(key, halves);
      order.push(key);
    }
    if (!halves.has(identity.half)) halves.set(identity.half, slot);
  }

  /** @type {string[]} */
  const blockers = [];
  for (const key of order) {
    const halves = /** @type {Map<string, VisualReviewRegion>} */ (groups.get(key));
    const first = halves.get('1');
    const second = halves.get('2');
    if (!first || !second) continue;
    const dy = round1(second.box.y - first.box.y);
    if (Math.abs(dy) > 1) {
      blockers.push(
        `Paired slots are not row-aligned: ${first.id} and ${second.id} differ in y by ${Math.abs(dy)}px.`,
      );
      continue;
    }
    const dh = round1(second.box.height - first.box.height);
    if (Math.abs(dh) > 1) {
      blockers.push(
        `Paired slots differ in height: ${first.id} and ${second.id} differ by ${Math.abs(dh)}px.`,
      );
    }
  }
  return blockers;
}

/**
 * @param {number} n
 * @returns {number}
 */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Repair `overall.score` when the model returns something outside the 0-100 scale
 * (a recurring bug: it sometimes returns the SUM of the 7 axis scores). Returns the
 * score to use plus the raw value for provenance. Only synthesizes a replacement
 * (clamped mean of the axis scores, 1 dp) when EVERY axis score is finite;
 * otherwise it leaves the (clamped) raw value alone. A model that ignores the
 * scale instruction and answers on the legacy 1-5 scale (raw <= 5 AND every axis
 * <= 5) is rescaled by 20 rather than reported as a near-zero score. Callers must
 * still gate on blockers independently of the score.
 *
 * @param {unknown} result
 * @returns {NormalizedScore}
 */
export function normalizeOverallScore(result) {
  const overall =
    result && typeof result === 'object'
      ? /** @type {Record<string, unknown>} */ (result).overall
      : undefined;
  const rawOriginal =
    overall && typeof overall === 'object'
      ? /** @type {Record<string, unknown>} */ (overall).score
      : undefined;
  const axesObj =
    result && typeof result === 'object'
      ? /** @type {Record<string, unknown>} */ (result).axes
      : undefined;
  const axes = axesObj && typeof axesObj === 'object' ? axesObj : {};
  const axisScores = Object.values(axes).map((a) =>
    a && typeof a === 'object'
      ? Number(/** @type {Record<string, unknown>} */ (a).score)
      : Number.NaN,
  );
  const allAxesFinite = axisScores.length > 0 && axisScores.every((s) => Number.isFinite(s));

  const rawNum = Number(rawOriginal);

  // Legacy 1-5 answer from a model that ignored the 0-100 instruction.
  if (
    Number.isFinite(rawNum) &&
    rawNum > 0 &&
    rawNum <= 5 &&
    allAxesFinite &&
    axisScores.every((s) => s > 0 && s <= 5)
  ) {
    return { score: round1(rawNum * 20), raw: rawOriginal, normalized: true };
  }

  const rawInRange = Number.isFinite(rawNum) && rawNum >= 0 && rawNum <= 100;

  if (rawInRange) {
    return { score: round1(rawNum), raw: rawOriginal, normalized: false };
  }
  if (allAxesFinite) {
    const mean = axisScores.reduce((sum, s) => sum + s, 0) / axisScores.length;
    const clamped = Math.min(100, Math.max(0, mean));
    return { score: round1(clamped), raw: rawOriginal, normalized: true };
  }
  const fallback = Number.isFinite(rawNum) ? Math.min(100, Math.max(0, rawNum)) : 0;
  return { score: round1(fallback), raw: rawOriginal, normalized: false };
}

/**
 * Stable identity key for a finding so the same defect, reworded round-to-round,
 * maps to one key. Lowercases, collapses whitespace, drops trailing punctuation,
 * and strips ONLY pixel/coordinate MEASUREMENTS (e.g. "18px", "x=384", "dx=-12").
 * It deliberately KEEPS bare semantic indices (e.g. "cell 0" vs "cell 8") so
 * genuinely different elements do not collapse together.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function findingKey(text) {
  if (typeof text !== 'string') return '';
  let s = text.toLowerCase();
  // Coordinate/delta assignments: x=384, y=-12, w=64, dx=-18, right=..., width=64, etc.
  s = s.replace(
    /\b(?:dx|dy|dw|dh|x|y|w|h|right|bottom|left|top|width|height)\s*=\s*[-+]?\d+(?:\.\d+)?/g,
    '',
  );
  // Pixel measurements: 18px, ~24px, -3.5 px.
  s = s.replace(/~?[-+]?\d+(?:\.\d+)?\s*px\b/g, '');
  // Collapse whitespace and drop trailing punctuation/space.
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[\s.;:,]+$/g, '');
  return s;
}

/**
 * Map a list of finding strings to their stable keys (dropping non-strings/empties).
 *
 * @param {readonly unknown[] | undefined} list
 * @returns {string[]}
 */
export function findingKeys(list) {
  const out = [];
  for (const item of list ?? []) {
    const key = findingKey(item);
    if (key) out.push(key);
  }
  return out;
}

/**
 * Collapse findings that share a stable key, keeping the FIRST original wording.
 *
 * @param {readonly string[] | undefined} list
 * @returns {string[]}
 */
export function dedupeFindings(list) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of list ?? []) {
    if (typeof item !== 'string') continue;
    const key = findingKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Split the current findings into NEW (not present in the prior run) vs RECURRING
 * (a key that appeared in the prior run), deduping the current list by key.
 *
 * @param {readonly string[] | undefined} prevKeys keys from the most recent prior review
 * @param {readonly string[] | undefined} current current-run finding strings
 * @returns {FindingDiff}
 */
export function diffFindings(prevKeys, current) {
  const prev = new Set(prevKeys ?? []);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const newFindings = [];
  /** @type {string[]} */
  const recurring = [];
  for (const item of current ?? []) {
    if (typeof item !== 'string') continue;
    const key = findingKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (prev.has(key)) recurring.push(item);
    else newFindings.push(item);
  }
  return { new: newFindings, recurring };
}

/**
 * Whether a run ended up WITHOUT pixel-grounded deterministic geometry, so the
 * caller must emit a loud (non-gating) warning. This is true in two cases, both
 * of which silently degrade to screenshot-only, subjective feedback — the exact
 * failure mode this tool exists to prevent:
 *
 *  - `'none'` — the surface declared no `window.__visualReview` and is not the
 *    legacy equipment probe, so no geometry was measured at all.
 *  - `'declared'` with ZERO valid regions — the setup declared the contract but
 *    every region was dropped (missing id, non-finite / zero-area box, etc.), a
 *    misconfiguration that would otherwise pass silently.
 *
 * `'equipment-legacy'` always has geometry (from its own probe, not regions), so
 * a zero `regionCount` there is expected and does NOT warrant a warning.
 *
 * @param {string} harvestSource
 * @param {number} regionCount
 * @returns {boolean}
 */
export function lacksPixelGroundedGeometry(harvestSource, regionCount) {
  if (harvestSource === 'none') return true;
  if (harvestSource === 'declared' && !(regionCount > 0)) return true;
  return false;
}
