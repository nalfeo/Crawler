import { extname } from 'node:path';

export const REVIEW_AXES = Object.freeze([
  'task_readiness',
  'decision_delta',
  'hierarchy',
  'legibility',
  'text_safety',
  'semantic_grammar',
  'workspace_use',
  'input_affordance',
  'context',
  'accessibility',
]);

const BEHAVIOR_CLAIM =
  /\b(?:clicking|hovering|equipping|unequipping|filtering|animating)\b|\b(?:click|hover|equip|unequip|filter)\s+(?:to|on|over|an|the)\b|\bupdate(?:s|d|ing)?\s+(?:after|when|on|based)\b/i;

const FUZZINESS_CLAIM =
  /\b(?:fuzz(?:y|iness)|blurr?(?:y|ed|iness)|soft(?:ened)?)\b.*\b(?:text|font|glyph|label|type|rasterization)\b|\b(?:text|font|glyph|label|type|rasterization)\b.*\b(?:fuzz(?:y|iness)|blurr?(?:y|ed|iness)|soft(?:ened)?)\b|\bsharper\s+(?:font|text)\b/i;

export function mediaTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.png':
      return 'image/png';
    default:
      throw new Error('image must be PNG, JPEG, or WebP');
  }
}

export function parseArgs(argv) {
  const values = {};
  const allowed = new Set(['--image', '--metadata', '--output', '--min-score', '--min-coverage']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inlineValue] = arg.split('=', 2);
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values[flag.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  if (!values.image) throw new Error('--image is required');
  return {
    image: values.image,
    metadata: values.metadata,
    output: values.output,
    minScore: numericOption(values.minScore, '--min-score'),
    minCoverage: numericOption(values.minCoverage, '--min-coverage'),
  };
}

function numericOption(value, flag) {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`${flag} must be a number from 0 to 100`);
  }
  return number;
}

export function parseMetadataText(text) {
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata must be a JSON object');
  }
  for (const field of ['task', 'viewport', 'uiScale']) {
    if (field in parsed && typeof parsed[field] !== 'string') {
      throw new Error(`metadata.${field} must be a string`);
    }
  }
  return parsed;
}

export function buildPrompt(metadata) {
  const task = metadata.task ?? 'the player task is unspecified';
  const textRaster = metadata.textRaster;
  const textRasterEvidence =
    textRaster?.passed === true
      ? ` Deterministic text-raster evidence passed for all declared text crops: intended fonts were loaded, final raster geometry was integer-aligned, and each crop met its sharp-edge baseline. Do not claim text is fuzzy, blurry, soft, or needs a sharper font unless the supplied evidence is visibly contradicted with high confidence.`
      : '';
  return {
    system: `You are an evidence-first RPG UX reviewer. Review only the attached still image.
Return JSON with observable, not_observable, evidence, player_cost, and hard_failures.
observable must have these axes: ${REVIEW_AXES.join(', ')}. Each axis must have score (0-100), observation, and evidence grounded in visible pixels.
not_observable must list interaction and state claims that a still image cannot prove.
evidence is an array of {criterion, observation, confidence} where confidence is 0-1.
player_cost is an array of concrete player costs. hard_failures is an array of unreadable, clipped, overlapping, or unsafe text failures.
Treat text that crosses the viewport edge, is clipped, or overflows its panel as a severe text_safety failure: score text_safety at 10 or below and include a hard_failure stating "text overflows off-screen".
Treat copious unused space that weakens scan efficiency as a workspace_use failure: score workspace_use at 40 or below and include a player_cost stating "copious wasted space". Inspect the top/header, the central paper-doll or focal interaction area, and the bottom/footer separately. Large empty background, oversized padding, or a mostly vacant region in any of those areas is a finding even when the remaining content is well grouped; do not describe the layout as efficient without addressing each region.
For workspace_use, provide region-specific evidence whenever the screenshot contains a header, paper-doll/focal area, or footer. If one region consumes substantial height or width without decision-supporting content, name that region and describe the visible empty area in player_cost.
Also inspect the outer frame. A continuous empty band along any screen edge that spans roughly a tenth or more of the frame width or height is a dead band: report it in player_cost naming the edge and describe it as wasted space, even when every panel is internally tidy. Content that occupies only part of the frame while panels are internally cramped is a workspace_use failure, not an acceptable trade.
Inspect any paper-doll, equipment-slot, or body-map region specifically. Equipment slots that carry no visible text label, no slot-name caption, and no distinguishing marker beyond an icon leave the player unable to name the slot from the image alone: report that in player_cost and score task_readiness at 55 or below with a player_cost describing "unlabeled equipment slots". Slots arranged in a plain uniform grid with no body-anchored silhouette, no left/right pairing cue, and no grouping caption are a spatial-model failure: describe the missing body anchoring in player_cost. Also state whether a filled slot is visually distinguishable from an empty slot.
For legibility, judge the smallest visible text against the stated viewport. Report body text that renders at a small pixel height, long uninterrupted all-capital runs, and label/value pairs separated by a wide gap with no connecting rule or alternating band, since each of those raises reading cost. When any of those are present, score legibility at 55 or below and name the specific text region in player_cost.
Never assert behavior such as equipping, clicking, hovering, filtering, selecting, stat updates, or animation as observable.
Do not use those behavior words anywhere in observable observations or evidence, even to say that they are absent or unproven.
For task_readiness, decision_delta, and input_affordance, describe only visible labels, controls, markers, values, and spatial relationships.`,
    user: `Review this screenshot for task "${task}". Viewport: ${metadata.viewport ?? 'unknown'}; UI scale: ${metadata.uiScale ?? 'unknown'}.${textRasterEvidence}
${metadata.regions ? `Declared regions: ${JSON.stringify(metadata.regions)}` : 'No declared regions were provided.'}
The screenshot is the sole visual evidence. Return JSON only.`,
  };
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeReview(raw, { image, metadata, modelDeployment }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('model response must be a JSON object');
  const observableRaw = raw.observable;
  if (!observableRaw || typeof observableRaw !== 'object' || Array.isArray(observableRaw)) {
    throw new Error('model response missing observable rubric');
  }
  const observable = {};
  let evidenceAxes = 0;
  for (const axis of REVIEW_AXES) {
    const candidate = observableRaw[axis];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`model response missing observable.${axis}`);
    }
    const score = Number(candidate.score);
    const observation = text(candidate.observation);
    const evidence = text(candidate.evidence);
    if (!Number.isFinite(score) || score < 0 || score > 100 || !observation || !evidence) {
      throw new Error(`observable.${axis} requires score, observation, and evidence`);
    }
    if (BEHAVIOR_CLAIM.test(`${observation} ${evidence}`)) {
      throw new Error(`observable.${axis} makes a behavior claim that a still image cannot prove`);
    }
    observable[axis] = { score, observation, evidence };
    evidenceAxes += 1;
  }
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .map((item) => ({
          criterion: text(item?.criterion),
          observation: text(item?.observation),
          confidence: Number(item?.confidence),
        }))
        .filter(
          (item) =>
            item.criterion &&
            item.observation &&
            Number.isFinite(item.confidence) &&
            item.confidence >= 0 &&
            item.confidence <= 1,
        )
    : [];
  const textRasterPassed = metadata?.textRaster?.passed === true;
  let suppressedTextRasterFindings = 0;
  const removeUnsupportedFuzziness = (items) =>
    items.filter((item) => {
      const suppress = textRasterPassed && FUZZINESS_CLAIM.test(item);
      if (suppress) suppressedTextRasterFindings += 1;
      return !suppress;
    });
  const rawHardFailures = Array.isArray(raw.hard_failures)
    ? raw.hard_failures
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    : [];
  const rawPlayerCost = Array.isArray(raw.player_cost)
    ? raw.player_cost
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    : [];
  const hardFailures = removeUnsupportedFuzziness(rawHardFailures);
  const playerCost = removeUnsupportedFuzziness(rawPlayerCost);
  const notObservable = Array.isArray(raw.not_observable)
    ? raw.not_observable
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    : [];
  if (
    hardFailures.some((item) =>
      /\b(?:text\s+)?(?:overflows?|overflowing|clipped|off-screen)\b/i.test(item),
    )
  ) {
    observable.text_safety.score = Math.min(observable.text_safety.score, 10);
  }
  const workspaceWaste = playerCost.some((item) =>
    /\b(?:copious|excessive|large|substantial|unused|empty|blank|wasted|vacant|dead)\b.{0,40}\b(?:space|area|region|background|padding|margin|band)\b/i.test(
      item,
    ),
  );
  if (workspaceWaste) {
    observable.workspace_use.score = Math.min(observable.workspace_use.score, 40);
  }
  const slotIdentityGap = playerCost.some((item) =>
    /\b(?:unlabeled|unlabelled|no\s+(?:visible\s+)?(?:text\s+)?labels?|without\s+labels?|missing\s+labels?)\b.{0,60}\b(?:slot|slots|paper.?doll|equipment)\b|\b(?:slot|slots|paper.?doll)\b.{0,60}\b(?:unlabeled|unlabelled|no\s+(?:visible\s+)?(?:text\s+)?labels?|lack\s+labels?)\b/i.test(
      item,
    ),
  );
  if (slotIdentityGap) {
    observable.task_readiness.score = Math.min(observable.task_readiness.score, 55);
  }
  const legibilityStrain = playerCost.some((item) =>
    /\b(?:small|tiny|reduced|low)\b.{0,30}\b(?:font|text|type|glyph)\b|\ball[- ]cap(?:ital)?s?\b|\b(?:wide|large|long)\b.{0,40}\b(?:gap|distance|separation)\b.{0,40}\b(?:label|value|column)\b/i.test(
      item,
    ),
  );
  if (legibilityStrain) {
    observable.legibility.score = Math.min(observable.legibility.score, 55);
  }
  const baseScore = Math.round(
    REVIEW_AXES.reduce((sum, axis) => sum + observable[axis].score, 0) / REVIEW_AXES.length,
  );
  const score = hardFailures.some((item) =>
    /\b(?:text\s+)?(?:overflows?|overflowing|clipped|off-screen)\b/i.test(item),
  )
    ? Math.min(baseScore, 45)
    : baseScore;
  return {
    schemaVersion: 1,
    kind: 'arbitrary-screenshot-review',
    image,
    metadata,
    modelDeployment,
    observable,
    evidence,
    playerCost,
    hardFailures,
    notObservable,
    limitations:
      notObservable.length === 0
        ? [
            'The model omitted not_observable limitations; interaction claims remain unproven by this still image.',
          ]
        : [],
    coverage: Math.round((evidenceAxes / REVIEW_AXES.length) * 100),
    score,
    prioritizedFindings: [...hardFailures, ...playerCost],
    suppressedTextRasterFindings,
  };
}

export function assertAdvisoryThresholds(result, { minScore, minCoverage }) {
  if (minScore !== null && result.score < minScore)
    throw new Error(`score ${result.score} is below advisory minimum ${minScore}`);
  if (minCoverage !== null && result.coverage < minCoverage)
    throw new Error(`coverage ${result.coverage} is below advisory minimum ${minCoverage}`);
}
