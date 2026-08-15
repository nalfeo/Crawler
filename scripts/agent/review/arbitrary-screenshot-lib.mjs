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
  return {
    system: `You are an evidence-first RPG UX reviewer. Review only the attached still image.
Return JSON with observable, not_observable, evidence, player_cost, and hard_failures.
observable must have these axes: ${REVIEW_AXES.join(', ')}. Each axis must have score (0-100), observation, and evidence grounded in visible pixels.
not_observable must list interaction and state claims that a still image cannot prove.
evidence is an array of {criterion, observation, confidence} where confidence is 0-1.
player_cost is an array of concrete player costs. hard_failures is an array of unreadable, clipped, overlapping, or unsafe text failures.
Never assert behavior such as equipping, clicking, hovering, filtering, selecting, stat updates, or animation as observable.
Do not use those behavior words anywhere in observable observations or evidence, even to say that they are absent or unproven.
For task_readiness, decision_delta, and input_affordance, describe only visible labels, controls, markers, values, and spatial relationships.`,
    user: `Review this screenshot for task "${task}". Viewport: ${metadata.viewport ?? 'unknown'}; UI scale: ${metadata.uiScale ?? 'unknown'}.
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
  const hardFailures = Array.isArray(raw.hard_failures)
    ? raw.hard_failures
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    : [];
  const playerCost = Array.isArray(raw.player_cost)
    ? raw.player_cost
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    : [];
  const notObservable = Array.isArray(raw.not_observable)
    ? raw.not_observable
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    : [];
  const score = Math.round(
    REVIEW_AXES.reduce((sum, axis) => sum + observable[axis].score, 0) / REVIEW_AXES.length,
  );
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
  };
}

export function assertAdvisoryThresholds(result, { minScore, minCoverage }) {
  if (minScore !== null && result.score < minScore)
    throw new Error(`score ${result.score} is below advisory minimum ${minScore}`);
  if (minCoverage !== null && result.coverage < minCoverage)
    throw new Error(`coverage ${result.coverage} is below advisory minimum ${minCoverage}`);
}
