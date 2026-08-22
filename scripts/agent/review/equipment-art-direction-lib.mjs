import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

export const ART_DIRECTION_PILLARS = Object.freeze([
  'identity_commitment',
  'icon_vocabulary_coherence',
  'palette_material_grammar',
  'semantic_color_integrity',
  'focal_hierarchy',
  'density_rhythm',
  'delta_storytelling',
  'genre_fluency',
  'delight_craft',
]);

const STOCK_PHRASES = /\b(?:generic|sterile|cramped|flat|busy)\b/i;
const NEUTRAL_COUNTERFACTUAL =
  /\b(?:lack|absence|missing)\b[^.]{0,80}\b(?:candidate|preview|delta|comparison|item changes?)\b|\b(?:candidate|preview|delta|comparison|item changes?)\b[^.]{0,80}\bmissing\b/i;
const NEGATIVE_NEUTRAL_STATE =
  /\bno\b[^.]{0,40}\b(?:candidate|preview|delta|comparison|item changes?)\b[^.]{0,120}\b(?:so|therefore|which|making|prevent|impossible|cannot|can't|harder|limit)\b/i;
const UNSUPPORTED_SEMANTIC_INFERENCE =
  /\b(?:tooltip|legend|universally understood|usable items?|rare items?|negative contributions?|red for reductions?|gray for neutral)\b/i;
const UNSUPPORTED_BAG_BORDER_TREATMENT =
  /\b(?:green|blue)\b[^.]{0,120}\b(?:borders?|outlines?)\b[^.]{0,120}\b(?:semantic|contribut|equippable|usable|rare|meaning)\b/i;
const BAG_BORDER_TREATMENT =
  /\b(?:bag\b[^.]{0,120}\b(?:green|blue|colou?rs?|borders?|outlines?)|(?:green|blue|colou?rs?|borders?|outlines?)\b[^.]{0,120}\bbag)\b/i;

export function neutralEquipmentScenario(version) {
  return {
    schemaVersion: 1,
    caseId: `equipment-neutral-${version}`,
    task: 'inspect_build',
    viewport: '1280x800',
    inputModality: 'mouse_keyboard',
    intent: {
      playerQuestion:
        'What is equipped, which slots are available, and what does this build emphasize?',
      primaryDecision: 'Inspect the current build before selecting a candidate item.',
      emotionalBeat:
        'A confident, readable character-sheet pause before the next dungeon decision.',
      preserve: ['Stable ten-slot body map', 'clear empty versus occupied slot distinction'],
    },
    stateContract: {
      state: 'default',
      relationship: 'none',
      equippedItem: 'starter main-hand weapon only',
      candidateItem: null,
      targetSlot: null,
      expectedDelta: 'not applicable',
      semanticColors: {
        green: 'visible positive contribution from equipped gear only',
        neutral: 'baseline or unchanged stat',
      },
    },
    artDirection: {
      identity: ['pixel dungeon crawler', 'reality-show dungeon', 'crafting-focused action RPG'],
      iconVocabulary: 'Item and slot icons should feel like one readable pixel-art family.',
      paletteMaterials:
        'Use restrained dungeon materials and panels without burying arithmetic in ornament.',
      delightTarget:
        'The paper doll should make the player curious about completing a build, not read as a form.',
    },
  };
}

export function discoverEquipmentCaptures(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => ({ version: entry.name, image: join(root, entry.name, 'equipment.png') }))
    .filter((entry) => existsSync(entry.image))
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

export function buildArtDirectionPrompt(scenario) {
  return {
    system: `You are Crawler's principal RPG UI art director. Your job is to judge design quality:
identity, thematic cohesion, visual storytelling, hierarchy, rhythm, genre fluency, and delight.

Use this project lookbook test: "Can the player understand their current build, inspect a candidate,
predict the result, and execute the action without holding hidden state in working memory?"

Judge these pillars: ${ART_DIRECTION_PILLARS.join(', ')}.

Evidence law:
- A geometric claim needs supplied measurements. Do not invent pixel offsets.
- An artistic claim must name a visible element, the property being judged, and a contrasting peer
  or visual consequence.
- A semantic or state claim must cite scenario metadata. Do not infer behavior from a still.
- Do not use "generic", "sterile", "cramped", "flat", or "busy" unless you name the visual cause
  and a specific design direction.
- Preserve good choices. Taste critique is not a list of defects.
- This is a neutral, no-candidate state. Do not penalize the deliberate absence of a candidate,
  preview, comparison card, delta, or prospective item action. Judge only the composition visible now.
- For "delta_storytelling", write exactly "No material concern visible." as the issue and a
  preservation direction. That pillar cannot identify the biggest problem or cheap high-payoff win here.
- Green has a defined meaning only for visible equipped-gear contributions in the Stats panel. Do not
  assign semantics to Bag borders or recommend legends, tooltips, rarity colors, or negative-stat colors
  unless the scenario metadata explicitly defines them.
- Do not mention Bag border or outline colors in any field. They are outside this scenario's semantic contract.
- A pillar may report no material concern visible. In that case write "No material concern visible."
  for "issue" and a preservation/refinement note for "direction"; do not invent a defect.

Return JSON only. Do not give an overall shipping score, a CI verdict, or blockers.`,
    user: `Review this historical Equipment screenshot.

SCENARIO METADATA (authoritative for intent/state):
${JSON.stringify(scenario, null, 2)}

Return exactly this shape:
{
  "scenario_specific_observations": [
    { "element": string, "property": string, "contrast_or_peer": string, "observation": string }
  ],
  "preservation_note": { "element": string, "why_preserve": string },
  "biggest_problem": {
    "pillar": "${ART_DIRECTION_PILLARS.join('" | "')}",
    "severity": "low" | "medium" | "high",
    "element": string,
    "property": string,
    "contrast_or_peer": string,
    "diagnosis": string,
    "design_direction": string
  },
  "cheap_high_payoff_win": {
    "pillar": "${ART_DIRECTION_PILLARS.join('" | "')}",
    "severity": "low" | "medium" | "high",
    "element": string,
    "property": string,
    "contrast_or_peer": string,
    "diagnosis": string,
    "design_direction": string
  },
  "pillars": {
    ${ART_DIRECTION_PILLARS.map(
      (pillar) =>
        `"${pillar}": { "rating": 1 | 2 | 3 | 4 | 5, "strength": string, "issue": string, "direction": string }`,
    ).join(',\n    ')}
  }
}

Give at least two observations that are specific to this neutral, no-candidate state rather than
boilerplate that could apply to any inventory screenshot.`,
  };
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${name} must be non-empty text`);
  return value.trim();
}

function rejectUnsupportedClaim(value, name) {
  if (NEUTRAL_COUNTERFACTUAL.test(value) || NEGATIVE_NEUTRAL_STATE.test(value)) {
    throw new Error(`${name} criticizes an intentionally absent neutral-state interaction`);
  }
  if (UNSUPPORTED_SEMANTIC_INFERENCE.test(value)) {
    throw new Error(`${name} infers unsupported color semantics or behavior`);
  }
  if (UNSUPPORTED_BAG_BORDER_TREATMENT.test(value) || BAG_BORDER_TREATMENT.test(value)) {
    throw new Error(
      `${name} mentions Bag border or outline treatment outside the scenario contract`,
    );
  }
}

function normalizeFinding(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} is required`);
  const finding = {
    pillar: requiredText(value.pillar, `${name}.pillar`),
    severity: requiredText(value.severity, `${name}.severity`),
    element: requiredText(value.element, `${name}.element`),
    property: requiredText(value.property, `${name}.property`),
    contrastOrPeer: requiredText(value.contrast_or_peer, `${name}.contrast_or_peer`),
    diagnosis: requiredText(value.diagnosis, `${name}.diagnosis`),
    designDirection: requiredText(value.design_direction, `${name}.design_direction`),
  };
  if (!ART_DIRECTION_PILLARS.includes(finding.pillar)) throw new Error(`${name}.pillar is invalid`);
  if (!['low', 'medium', 'high'].includes(finding.severity))
    throw new Error(`${name}.severity is invalid`);
  if (finding.pillar === 'delta_storytelling') {
    throw new Error(`${name}.pillar cannot headline a neutral no-candidate review`);
  }
  if (STOCK_PHRASES.test(finding.diagnosis) && finding.designDirection.length < 12) {
    throw new Error(`${name} uses a stock phrase without a concrete design direction`);
  }
  rejectUnsupportedClaim(Object.values(finding).join(' '), name);
  return finding;
}

export function normalizeArtDirectionReview(raw, { image, scenario, modelDeployment }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('model response must be an object');
  if (
    !Array.isArray(raw.scenario_specific_observations) ||
    raw.scenario_specific_observations.length < 2
  ) {
    throw new Error('model response requires two scenario_specific_observations');
  }
  const observations = raw.scenario_specific_observations.map((value, index) => {
    const observation = requiredText(value?.observation, `observation ${index}.observation`);
    const normalizedObservation = {
      element: requiredText(value?.element, `observation ${index}.element`),
      property: requiredText(value?.property, `observation ${index}.property`),
      contrastOrPeer: requiredText(
        value?.contrast_or_peer,
        `observation ${index}.contrast_or_peer`,
      ),
      observation,
    };
    rejectUnsupportedClaim(Object.values(normalizedObservation).join(' '), `observation ${index}`);
    return normalizedObservation;
  });
  const preservation = raw.preservation_note;
  if (!preservation || typeof preservation !== 'object' || Array.isArray(preservation)) {
    throw new Error('model response requires preservation_note');
  }
  const pillars = {};
  if (!raw.pillars || typeof raw.pillars !== 'object' || Array.isArray(raw.pillars)) {
    throw new Error('model response requires pillars');
  }
  for (const pillar of ART_DIRECTION_PILLARS) {
    const value = raw.pillars[pillar];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`model response missing pillars.${pillar}`);
    }
    const rating = Number(value.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error(`pillars.${pillar}.rating must be an integer from 1 to 5`);
    }
    const strength = requiredText(value.strength, `pillars.${pillar}.strength`);
    pillars[pillar] = {
      rating,
      strength,
      issue: requiredText(value.issue, `pillars.${pillar}.issue`),
      direction: requiredText(value.direction, `pillars.${pillar}.direction`),
    };
    rejectUnsupportedClaim(strength, `pillars.${pillar}.strength`);
    rejectUnsupportedClaim(pillars[pillar].issue, `pillars.${pillar}.issue`);
    rejectUnsupportedClaim(pillars[pillar].direction, `pillars.${pillar}.direction`);
    if (pillar === 'delta_storytelling') {
      if (pillars[pillar].issue !== 'No material concern visible.') {
        throw new Error(
          'pillars.delta_storytelling.issue must preserve the neutral no-candidate state',
        );
      }
      if (!/\bpreserv/i.test(pillars[pillar].direction)) {
        throw new Error(
          'pillars.delta_storytelling.direction must preserve the neutral no-candidate state',
        );
      }
    }
  }
  const preservationElement = requiredText(preservation.element, 'preservation_note.element');
  const preservationWhy = requiredText(preservation.why_preserve, 'preservation_note.why_preserve');
  rejectUnsupportedClaim(`${preservationElement} ${preservationWhy}`, 'preservation_note');
  return {
    schemaVersion: 1,
    kind: 'equipment-art-direction-review',
    image,
    imageName: basename(image),
    scenario,
    modelDeployment,
    scenarioSpecificObservations: observations,
    preservationNote: {
      element: preservationElement,
      whyPreserve: preservationWhy,
    },
    biggestProblem: normalizeFinding(raw.biggest_problem, 'biggest_problem'),
    cheapHighPayoffWin: normalizeFinding(raw.cheap_high_payoff_win, 'cheap_high_payoff_win'),
    pillars,
  };
}

export function summarizeArtDirectionReviews(reviews) {
  const completed = reviews.filter((review) => review.status === 'completed');
  const repeatedBiggestProblems = new Map();
  for (const review of completed) {
    const key = review.result.biggestProblem.diagnosis.toLowerCase().replace(/\s+/g, ' ').trim();
    repeatedBiggestProblems.set(key, (repeatedBiggestProblems.get(key) ?? 0) + 1);
  }
  return {
    total: reviews.length,
    completed: completed.length,
    failed: reviews.length - completed.length,
    repeatedBiggestProblems: [...repeatedBiggestProblems.entries()]
      .filter(([, count]) => count > 1)
      .map(([diagnosis, count]) => ({ diagnosis, count })),
  };
}
