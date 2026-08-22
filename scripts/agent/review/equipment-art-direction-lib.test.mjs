import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ART_DIRECTION_PILLARS,
  buildArtDirectionPrompt,
  discoverEquipmentCaptures,
  neutralEquipmentScenario,
  normalizeArtDirectionReview,
  summarizeArtDirectionReviews,
} from './equipment-art-direction-lib.mjs';

function response() {
  const pillars = Object.fromEntries(
    ART_DIRECTION_PILLARS.map((pillar) => [
      pillar,
      {
        rating: 3,
        strength: 'A clear strength.',
        issue: 'A bounded issue.',
        direction: 'Refine it.',
      },
    ]),
  );
  pillars.delta_storytelling = {
    rating: 3,
    strength: 'The current build snapshot is coherent.',
    issue: 'No material concern visible.',
    direction: 'Preserve the neutral no-candidate presentation.',
  };
  return {
    scenario_specific_observations: [
      {
        element: 'paper doll',
        property: 'empty slot treatment',
        contrast_or_peer: 'occupied main hand slot',
        observation: 'The empty slots read as intentionally available rather than broken.',
      },
      {
        element: 'stats panel',
        property: 'quiet baseline values',
        contrast_or_peer: 'equipment slots',
        observation: 'The neutral state lets the build silhouette lead before arithmetic.',
      },
    ],
    preservation_note: {
      element: 'slot labels',
      why_preserve: 'They keep the body map learnable.',
    },
    biggest_problem: {
      pillar: 'identity_commitment',
      severity: 'medium',
      element: 'panel frames',
      property: 'uniform navy treatment',
      contrast_or_peer: 'item sprites',
      diagnosis:
        'The shared panel treatment lacks a material cue that anchors the dungeon fiction.',
      design_direction: 'Give the primary frame a restrained forged-metal edge treatment.',
    },
    cheap_high_payoff_win: {
      pillar: 'delight_craft',
      severity: 'low',
      element: 'paper doll',
      property: 'empty-slot silhouettes',
      contrast_or_peer: 'filled main hand',
      diagnosis: 'The doll has room for one more authored character cue.',
      design_direction: 'Use one subtle body silhouette behind the slot map.',
    },
    pillars,
  };
}

test('creates a neutral scenario and art-direction prompt from the lookbook contract', () => {
  const scenario = neutralEquipmentScenario('v0.1.7');
  assert.equal(scenario.stateContract.relationship, 'none');
  assert.match(buildArtDirectionPrompt(scenario).system, /thematic cohesion/i);
  assert.match(buildArtDirectionPrompt(scenario).user, /scenario_specific_observations/);
});

test('normalizes complete art direction responses and rejects incomplete ones', () => {
  const result = normalizeArtDirectionReview(response(), {
    image: 'equipment.png',
    scenario: neutralEquipmentScenario('v0.1.7'),
    modelDeployment: 'test',
  });
  assert.equal(result.pillars.delta_storytelling.rating, 3);
  assert.equal(result.biggestProblem.pillar, 'identity_commitment');
  const invalid = response();
  invalid.scenario_specific_observations.pop();
  assert.throws(
    () =>
      normalizeArtDirectionReview(invalid, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /two scenario_specific_observations/,
  );
});

test('rejects neutral-state counterfactuals and unsupported color-semantics claims', () => {
  const counterfactual = response();
  counterfactual.pillars.delta_storytelling.issue =
    'The lack of a candidate item makes it harder to predict changes.';
  assert.throws(
    () =>
      normalizeArtDirectionReview(counterfactual, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /intentionally absent neutral-state interaction/,
  );

  const unsupportedSemantics = response();
  unsupportedSemantics.biggest_problem.design_direction =
    'Add a legend explaining that green borders mean usable items.';
  assert.throws(
    () =>
      normalizeArtDirectionReview(unsupportedSemantics, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /unsupported color semantics or behavior/,
  );

  const bagBorderSemantics = response();
  bagBorderSemantics.biggest_problem.diagnosis =
    'Green borders on Bag items suggest positive contributions without a clear semantic meaning.';
  assert.throws(
    () =>
      normalizeArtDirectionReview(bagBorderSemantics, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /Bag border or outline treatment/,
  );

  const unsupportedObservation = response();
  unsupportedObservation.scenario_specific_observations[0].observation =
    'The lack of a candidate item prevents meaningful inspection.';
  assert.throws(
    () =>
      normalizeArtDirectionReview(unsupportedObservation, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /intentionally absent neutral-state interaction/,
  );

  const unsupportedPreservation = response();
  unsupportedPreservation.preservation_note.why_preserve =
    'Green borders on Bag items make them feel equippable.';
  assert.throws(
    () =>
      normalizeArtDirectionReview(unsupportedPreservation, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /Bag border or outline treatment/,
  );

  const unsupportedStrength = response();
  unsupportedStrength.pillars.semantic_color_integrity.strength =
    'Green borders on Bag items mean rare items.';
  assert.throws(
    () =>
      normalizeArtDirectionReview(unsupportedStrength, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /unsupported color semantics or behavior/,
  );

  const deltaHeadline = response();
  deltaHeadline.biggest_problem.pillar = 'delta_storytelling';
  assert.throws(
    () =>
      normalizeArtDirectionReview(deltaHeadline, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /cannot headline/,
  );

  const invalidDeltaPillar = response();
  invalidDeltaPillar.pillars.delta_storytelling.issue = 'A candidate preview is missing.';
  assert.throws(
    () =>
      normalizeArtDirectionReview(invalidDeltaPillar, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /intentionally absent neutral-state interaction/,
  );

  const negativeNeutralState = response();
  negativeNeutralState.scenario_specific_observations[0].observation =
    'There is no candidate preview, so comparison is impossible.';
  assert.throws(
    () =>
      normalizeArtDirectionReview(negativeNeutralState, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /intentionally absent neutral-state interaction/,
  );

  const unsupportedObservationMetadata = response();
  unsupportedObservationMetadata.scenario_specific_observations[0].element =
    'Bag border colors that mean equippable items';
  assert.throws(
    () =>
      normalizeArtDirectionReview(unsupportedObservationMetadata, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /Bag border or outline treatment/,
  );

  const unsupportedPreservationElement = response();
  unsupportedPreservationElement.preservation_note.element =
    'Bag green border meaning equippable items';
  assert.throws(
    () =>
      normalizeArtDirectionReview(unsupportedPreservationElement, {
        image: 'equipment.png',
        scenario: neutralEquipmentScenario('v0.1.7'),
        modelDeployment: 'test',
      }),
    /Bag border or outline treatment/,
  );
});

test('summarizes repeated diagnoses without treating consistency as failure', () => {
  const result = normalizeArtDirectionReview(response(), {
    image: 'equipment.png',
    scenario: neutralEquipmentScenario('v0.1.7'),
    modelDeployment: 'test',
  });
  const summary = summarizeArtDirectionReviews([
    { status: 'completed', result },
    { status: 'completed', result },
    { status: 'failed' },
  ]);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.repeatedBiggestProblems[0].count, 2);
});

test('discovers only versioned neutral equipment captures', () => {
  const captures = discoverEquipmentCaptures('files/visual-review/after');
  assert.deepEqual(
    captures.map((capture) => capture.version),
    ['v0.1.0', 'v0.1.1', 'v0.1.2', 'v0.1.3', 'v0.1.4', 'v0.1.5', 'v0.1.6', 'v0.1.7'],
  );
});
