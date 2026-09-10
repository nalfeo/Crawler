import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalFloorEpicPath,
  lintFloorEpic,
  outputPathViolation,
  type FloorEpic,
  type FloorEpicNode,
} from '../../../scripts/agent/epics/floor-epic-lint.js';

const PERSONA_NAMES = [
  'Producer',
  'Systems Engineer',
  'Game Designer',
  'Game AI Engineer',
  'Content Designer',
  'Graphics Designer',
  'Set Designer',
  'UX Designer',
  'QA Engineer',
  'DevOps Engineer',
  'Playtester',
  'Reviewer',
];

/**
 * A representative, fully-compliant floor epic modeled on the real
 * `floor-3-ai-runner-completion.epic.json` conventions (`Owner: <Persona>.`
 * node bodies, a single dual-runner proof node, a terminal release/MVP
 * slice). Used as the positive control and as the base every regression
 * fixture below mutates exactly one invariant away from.
 */
function goodFloorEpic(): FloorEpic {
  return {
    epic_id: 'floor-9-example-completion',
    title: 'Floor 9 example completion',
    description: 'Make Floor 9 completable end to end through shared, config-driven mechanics.',
    hard_gate:
      'A representative seed must spawn, survive, and reach the real win/victory condition, ' +
      'proven independently by both the headless runner and the visual AI Runner.',
    non_goals: [
      'Numeric balance tuning and win-rate targets are explicitly out of scope for this epic.',
      'Other floors and cross-floor content are out of scope.',
    ],
    human_gates: [
      'Defer numeric balance, pacing, and difficulty tuning to Playtester evidence and Game ' +
        'Designer follow-up before any sweep-based sign-off.',
    ],
    nodes: [
      {
        id: 'contract-and-foundation',
        title: 'Floor 9 slice 1: contract and foundation',
        body:
          'Owner: Systems Engineer.\n\n' +
          'Establish the floor manifest and ScenarioDefinition contract needed to move the ' +
          'floor from scaffolded to bootable before any mechanic is bootable.',
      },
      {
        id: 'ai-mechanics',
        title: 'Floor 9 slice 2: shared AI mechanics',
        body:
          'Owner: Game AI Engineer.\n\n' +
          'Wire deterministic behavior so the floor becomes playable end to end for the ' +
          'production BehaviorTreeAI, composed entirely through the shared ScenarioDefinition ' +
          'manifest (no floor-ID branches).',
        depends_on: ['contract-and-foundation'],
      },
      {
        id: 'presentation',
        title: 'Floor 9 slice 3: presentation',
        body:
          'Owner: UX Designer.\n\n' +
          'Make every blocking modal completable through the same public callbacks the AI ' +
          'Runner and player share.',
        depends_on: ['ai-mechanics'],
      },
      {
        id: 'dual-runner-acceptance',
        title: 'Floor 9 slice 4: dual-runner acceptance',
        body:
          'Owner: QA Engineer.\n\n' +
          'Prove headless and visual AI Runner acceptance on one shared seed: spawn to win end ' +
          'to end with no shortcuts, teleports, or forced victories.',
        depends_on: ['ai-mechanics', 'presentation'],
      },
      {
        id: 'achievement-qa',
        title: 'Floor 9 slice 5: achievement-integrated QA',
        body:
          'Owner: QA Engineer.\n\n' +
          'Verify the floor achievement unlocks after the measurable objective and that its ' +
          'reward can be claimed exactly once. Done when the unlock, claim, and reward assertions pass.',
        depends_on: ['dual-runner-acceptance'],
      },
      {
        id: 'release',
        title: 'Floor 9 slice 6: release',
        body:
          'Owner: Producer.\n\n' +
          'Enable the release/MVP flag now that the floor is released for players, gated ' +
          'behind dual-runner acceptance.',
        depends_on: ['achievement-qa'],
      },
    ],
  };
}

function cloneEpic(epic: FloorEpic): FloorEpic {
  return JSON.parse(JSON.stringify(epic)) as FloorEpic;
}

function withNode(
  epic: FloorEpic,
  nodeId: string,
  mutate: (node: FloorEpicNode) => FloorEpicNode,
): FloorEpic {
  return {
    ...epic,
    nodes: epic.nodes.map((n) => (n.id === nodeId ? mutate(n) : n)),
  };
}

describe('canonicalFloorEpicPath', () => {
  it('matches the Floor Factory output contract path', () => {
    expect(canonicalFloorEpicPath('floor-9-example-completion')).toBe(
      'docs/knowledge/epics/floor-9-example-completion/floor-9-example-completion.epic.json',
    );
  });
});

describe('lintFloorEpic — positive control', () => {
  it('reports no violations for a fully-compliant floor epic', () => {
    expect(lintFloorEpic(goodFloorEpic(), PERSONA_NAMES)).toEqual([]);
  });
});

describe('lintFloorEpic — generic schema/DAG constraints', () => {
  it('flags a dependency cycle as a schema violation', () => {
    const epic = cloneEpic(goodFloorEpic());
    // Introduce a cycle: contract-and-foundation now (also) depends on release.
    const mutated = withNode(epic, 'contract-and-foundation', (n) => ({
      ...n,
      depends_on: ['release'],
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.some((v) => v.code === 'schema')).toBe(true);
  });

  it('flags an unknown depends_on reference as a schema violation', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'release', (n) => ({
      ...n,
      depends_on: ['does-not-exist'],
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.some((v) => v.code === 'schema')).toBe(true);
  });
});

describe('lintFloorEpic — regression fixtures (one violated invariant each)', () => {
  it('flags a floor epic without an achievement slice', () => {
    const epic = cloneEpic(goodFloorEpic());
    const withoutAchievement = {
      ...epic,
      nodes: epic.nodes
        .filter((node) => node.id !== 'achievement-qa')
        .map((node) =>
          node.id === 'release' ? { ...node, depends_on: ['dual-runner-acceptance'] } : node,
        ),
    };
    const violations = lintFloorEpic(withoutAchievement, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-slice-missing');
  });

  it('requires achievement acceptance to include dependency and reward claims', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'achievement-qa', (node) => ({
      ...node,
      body: 'Owner: QA Engineer.\n\nAdd achievement coverage.',
      depends_on: [],
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-dependency-missing');
    expect(violations.map((v) => v.code)).toContain('achievement-acceptance-missing');
  });

  it('requires achievement evidence for both unlock and reward claiming', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'achievement-qa', (node) => ({
      ...node,
      body:
        'Owner: QA Engineer.\n\n' +
        'Verify the floor achievement reward can be claimed exactly once. ' +
        'Done when the claim assertion passes.',
      depends_on: ['dual-runner-acceptance'],
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-acceptance-missing');
  });

  it('requires numeric achievement thresholds to defer to a HUMAN_GATE', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = {
      ...epic,
      human_gates: ['Balance numbers will be finalized later.'],
      nodes: epic.nodes.map((node) =>
        node.id === 'achievement-qa'
          ? {
              ...node,
              body:
                'Owner: QA Engineer.\n\n' +
                'Verify the floor achievement unlocks after at least 25 kills and its reward can be claimed exactly once. ' +
                'Done when the unlock and claim assertions pass.',
              depends_on: ['dual-runner-acceptance'],
            }
          : node,
      ),
    };
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-human-gate-missing');
  });

  it('detects ordinary numeric achievement wording as a threshold', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = {
      ...epic,
      human_gates: ['Balance numbers will be finalized later.'],
      nodes: epic.nodes.map((node) =>
        node.id === 'achievement-qa'
          ? {
              ...node,
              body:
                'Owner: QA Engineer.\n\n' +
                'Verify the floor achievement unlocks after 25 kills and its reward can be claimed exactly once. ' +
                'Done when the unlock and claim assertions pass.',
              depends_on: ['dual-runner-acceptance'],
            }
          : node,
      ),
    };
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-human-gate-missing');
  });

  it.each([
    [
      'item count',
      'Verify the floor achievement unlocks after collecting 10 relics and its reward can be claimed exactly once.',
    ],
    [
      'level target',
      'Verify the floor achievement unlocks after the player reaches level 20 and its reward can be claimed exactly once.',
    ],
    [
      'percentage target',
      'Verify the floor achievement unlocks when the run finishes with 50% health remaining and its reward can be claimed exactly once.',
    ],
    [
      'qualified ambiguous unit',
      'Verify the floor achievement unlocks after the player reaches 30 hp remaining and its reward can be claimed exactly once.',
    ],
  ])('detects a numeric achievement threshold expressed as %s', (_label, sentence) => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = {
      ...epic,
      human_gates: ['Balance numbers will be finalized later.'],
      nodes: epic.nodes.map((node) =>
        node.id === 'achievement-qa'
          ? {
              ...node,
              body: `Owner: QA Engineer.\n\n${sentence} Done when the unlock and claim assertions pass.`,
              depends_on: ['dual-runner-acceptance'],
            }
          : node,
      ),
    };
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-human-gate-missing');
  });

  it('rejects an achievement HUMAN_GATE that only defers a generic balance gate without naming achievements', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = {
      ...epic,
      // Owner-bearing, persona-named, but never mentions "achievement" —
      // must not satisfy the achievement-specific deferral contract.
      human_gates: [
        'Defer numeric balance, pacing, and difficulty tuning to Playtester evidence and Game ' +
          'Designer follow-up before any sweep-based sign-off.',
      ],
      nodes: epic.nodes.map((node) =>
        node.id === 'achievement-qa'
          ? {
              ...node,
              body:
                'Owner: QA Engineer.\n\n' +
                'Verify the floor achievement unlocks after 25 kills and its reward can be claimed exactly once. ' +
                'Done when the unlock and claim assertions pass.',
              depends_on: ['dual-runner-acceptance'],
            }
          : node,
      ),
    };
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-human-gate-missing');
  });

  it('does not require a HUMAN_GATE for an unqualified ambiguous-unit mention (flavor text, not a threshold)', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'achievement-qa', (node) => ({
      ...node,
      body:
        'Owner: QA Engineer.\n\n' +
        'Verify the floor achievement unlocks when the boss deals 50 hp damage per hit and its ' +
        'reward can be claimed exactly once. Done when the unlock and claim assertions pass.',
    }));
    expect(lintFloorEpic(mutated, PERSONA_NAMES)).toEqual([]);
  });

  it('does not treat a release node that only references achievement QA completion as achievement-owning', () => {
    const epic = cloneEpic(goodFloorEpic());
    // The release node references the achievement slice's completion but
    // does no achievement work itself — it must not be forced through the
    // owner/dependency/acceptance/HUMAN_GATE checks meant for the node that
    // actually owns the achievement work.
    const mutated = withNode(epic, 'release', (node) => ({
      ...node,
      body:
        'Owner: Producer.\n\n' +
        'Enable the release/MVP flag now that the floor is released for players, gated ' +
        'behind dual-runner acceptance and after achievement QA has passed.',
    }));
    expect(lintFloorEpic(mutated, PERSONA_NAMES)).toEqual([]);
  });

  it('requires an achievement slice to declare exactly one Owner persona', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'achievement-qa', (node) => ({
      ...node,
      body:
        'Owner: QA Engineer.\n' +
        'Owner: Game Designer.\n\n' +
        'Verify the floor achievement unlocks and its reward can be claimed exactly once. ' +
        'Done when the unlock and claim assertions pass.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-owner-count');
  });

  it('rejects an achievement slice with no Owner declaration', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'achievement-qa', (node) => ({
      ...node,
      body:
        'Verify the floor achievement unlocks and its reward can be claimed exactly once. ' +
        'Done when the unlock and claim assertions pass.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('achievement-owner-count');
  });

  it('flags a missing hard gate', () => {
    const epic = cloneEpic(goodFloorEpic());
    delete (epic as { hard_gate?: string }).hard_gate;
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('hard-gate-missing');
  });

  it('flags a hard gate that does not require both runners', () => {
    const epic = cloneEpic(goodFloorEpic());
    (epic as { hard_gate?: string }).hard_gate =
      'A representative seed must spawn and reach the real win condition.';
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('hard-gate-not-dual-runner');
  });

  it('flags missing non-goals', () => {
    const epic = cloneEpic(goodFloorEpic());
    (epic as { non_goals?: string[] }).non_goals = [];
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('non-goals-missing');
  });

  it('flags missing HUMAN_GATE deferrals', () => {
    const epic = cloneEpic(goodFloorEpic());
    (epic as { human_gates?: string[] }).human_gates = [];
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('human-gates-missing');
  });

  it('flags HUMAN_GATE deferrals that do not name an owning persona', () => {
    const epic = cloneEpic(goodFloorEpic());
    (epic as { human_gates?: string[] }).human_gates = ['Balance numbers will be finalized later.'];
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('human-gates-no-owner');
  });

  it('flags a node with no Owner tag', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'ai-mechanics', (n) => ({
      ...n,
      body: 'Wire deterministic behavior so the floor becomes playable end to end.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('node-owner-missing');
  });

  it('flags a node Owner that is not a known persona', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'ai-mechanics', (n) => ({
      ...n,
      body: n.body!.replace('Owner: Game AI Engineer.', 'Owner: Enemy Wrangler.'),
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('node-owner-unknown');
  });

  it('flags a node that owns numeric balance/pacing directly instead of deferring it', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'ai-mechanics', (n) => ({
      ...n,
      body:
        'Owner: Game Designer.\n\n' +
        'Tune the floor spawn-rate and damage numbers directly to hit a win-rate target.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('node-owns-balance');
  });

  it('flags a floor-ID branch smell in shared runtime paths', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'ai-mechanics', (n) => ({
      ...n,
      body: `${n.body}\n\nImplement via \`if (floorId === 'floor9')\` in the shared runner.`,
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('floor-branch-smell');
  });

  it('flags a floor-ID inequality branch smell (!==)', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'ai-mechanics', (n) => ({
      ...n,
      body: `${n.body}\n\nGuard via \`if (world.floorId !== 'floor9') return;\` in the shared runner.`,
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('floor-branch-smell');
  });

  it('flags a numeric floor-ID equality branch smell (world.floor === 9)', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'ai-mechanics', (n) => ({
      ...n,
      body: `${n.body}\n\nGuard via \`if (world.floor === 9) { ... }\` in the shared runner.`,
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('floor-branch-smell');
  });

  it('flags a switch(floorId) dispatch branch smell', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'ai-mechanics', (n) => ({
      ...n,
      body: `${n.body}\n\nDispatch via \`switch (floorId) { case 'floor9': ... }\` in the shared runner.`,
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('floor-branch-smell');
  });

  it('does not flag a floor-ID branch smell excused by a documented ADR reference', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'ai-mechanics', (n) => ({
      ...n,
      body:
        `${n.body}\n\nImplement via \`if (floorId === 'floor9')\` in the shared runner, per ` +
        'docs/knowledge/adr/2026-08-25-floor9-no-composable-alternative.md, which documents ' +
        'that no composable alternative exists.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).not.toContain('floor-branch-smell');
  });

  it('flags a plan with no config-driven (ScenarioDefinition/manifest) composition', () => {
    const epic = cloneEpic(goodFloorEpic());
    let mutated = withNode(epic, 'contract-and-foundation', (n) => ({
      ...n,
      body: 'Owner: Systems Engineer.\n\nEstablish the floor contract before anything is bootable.',
    }));
    mutated = withNode(mutated, 'ai-mechanics', (n) => ({
      ...n,
      body:
        'Owner: Game AI Engineer.\n\n' +
        'Wire deterministic behavior so the floor becomes playable end to end for the ' +
        'production BehaviorTreeAI, with no floor-ID branches.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('config-driven-composition-missing');
  });

  it('flags a plan with no dual-runner proof node', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'dual-runner-acceptance', (n) => ({
      ...n,
      body: 'Owner: QA Engineer.\n\nProve headless completion on one shared seed.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('dual-runner-proof-missing');
  });

  it('flags a boot-only smoke-test node as a false positive for dual-runner proof', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'dual-runner-acceptance', (n) => ({
      ...n,
      body: 'Owner: QA Engineer.\n\nHeadless and visual smoke-test acceptance on boot.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('dual-runner-proof-missing');
  });

  it('flags a plan with more than one terminal (no-dependents) slice', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'dual-runner-acceptance', (n) => ({
      ...n,
      depends_on: ['ai-mechanics'],
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('release-slice-not-unique-terminal');
  });

  it('flags a terminal slice that is not the release/MVP slice', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'release', (n) => ({
      ...n,
      body: 'Owner: Producer.\n\nWrap up remaining follow-up work.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('release-slice-not-final');
  });

  it('accepts a release slice gated transitively behind the dual-runner proof node', () => {
    const epic = cloneEpic(goodFloorEpic());
    const withExtra: FloorEpic = {
      ...epic,
      nodes: [
        ...epic.nodes.map((n) =>
          n.id === 'release' ? { ...n, depends_on: ['achievement-qa', 'extra-milestone'] } : n,
        ),
        {
          id: 'extra-milestone',
          title: 'Floor 9 slice: extra milestone',
          body: 'Owner: Producer.\n\nAn unrelated bookkeeping milestone.',
          depends_on: ['dual-runner-acceptance'],
        },
      ],
    };
    // A unique terminal node necessarily has every other node as a transitive
    // ancestor, so the dual-runner proof node is always reachable from the
    // release slice once uniqueness holds — this stays violation-free.
    expect(lintFloorEpic(withExtra, PERSONA_NAMES)).toEqual([]);
  });

  it('flags a plan exceeding the eight-slice cap with no recorded human exception', () => {
    const nodes: FloorEpicNode[] = [];
    for (let i = 1; i <= 9; i += 1) {
      nodes.push({
        id: `slice-${i}`,
        title: `Floor 9 slice ${i}`,
        body:
          `Owner: Systems Engineer.\n\n` +
          'Progress the floor through bootable, playable, completable, and released stages, ' +
          'composed via the ScenarioDefinition manifest with proof from the headless runner ' +
          'and the visual AI Runner acceptance suite.',
        depends_on: i > 1 ? [`slice-${i - 1}`] : undefined,
      });
    }
    nodes[nodes.length - 1] = {
      ...nodes[nodes.length - 1]!,
      body: `${nodes[nodes.length - 1]!.body}\n\nRelease/MVP flag enablement.`,
    };
    const epic: FloorEpic = { ...goodFloorEpic(), nodes };
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('slice-cap-exceeded');
  });

  it('allows exceeding the eight-slice cap with a recorded human-approved exception', () => {
    const nodes: FloorEpicNode[] = [];
    for (let i = 1; i <= 9; i += 1) {
      nodes.push({
        id: `slice-${i}`,
        title: `Floor 9 slice ${i}`,
        body:
          'Owner: Systems Engineer.\n\n' +
          'Progress the floor through bootable, playable, completable, and released stages, ' +
          'composed via the ScenarioDefinition manifest with proof from the headless runner ' +
          'and the visual AI Runner acceptance suite.',
        depends_on: i > 1 ? [`slice-${i - 1}`] : undefined,
      });
    }
    nodes[nodes.length - 1] = {
      ...nodes[nodes.length - 1]!,
      body: `${nodes[nodes.length - 1]!.body}\n\nRelease/MVP flag enablement.`,
    };
    const epic: FloorEpic = {
      ...goodFloorEpic(),
      nodes,
      human_approved_exception_reason: 'nalfeo approved a 9-slice plan on 2026-09-02.',
    };
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).not.toContain('slice-cap-exceeded');
  });

  it('flags a plan that does not distinguish progressive playability stages', () => {
    const epic = cloneEpic(goodFloorEpic());
    let mutated = withNode(epic, 'contract-and-foundation', (n) => ({
      ...n,
      body: 'Owner: Systems Engineer.\n\nEstablish the floor manifest and ScenarioDefinition contract.',
    }));
    mutated = withNode(mutated, 'ai-mechanics', (n) => ({
      ...n,
      body:
        'Owner: Game AI Engineer.\n\n' +
        'Wire deterministic behavior for the production BehaviorTreeAI, composed entirely ' +
        'through the shared ScenarioDefinition manifest (no floor-ID branches).',
    }));
    mutated = withNode(mutated, 'presentation', (n) => ({
      ...n,
      body:
        'Owner: UX Designer.\n\n' +
        'Make every blocking modal work through the same public callbacks the AI Runner and ' +
        'player share.',
    }));
    mutated = withNode(mutated, 'release', (n) => ({
      ...n,
      body: 'Owner: Producer.\n\nEnable the flag now that the floor is done for players.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('playability-stages-underspecified');
  });

  it('flags a plan missing only the "scaffolded" stage (does not conflate it with the other 5)', () => {
    const epic = cloneEpic(goodFloorEpic());
    const mutated = withNode(epic, 'contract-and-foundation', (n) => ({
      ...n,
      body:
        'Owner: Systems Engineer.\n\n' +
        'Establish the floor manifest and ScenarioDefinition contract needed before any ' +
        'mechanic is bootable.',
    }));
    const violations = lintFloorEpic(mutated, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('playability-stages-underspecified');
    const stageViolation = violations.find((v) => v.code === 'playability-stages-underspecified');
    expect(stageViolation?.message).toContain('scaffolded');
  });
});

describe('lintFloorEpic — additive field type validation', () => {
  it('flags a non-string hard_gate as a schema violation instead of throwing', () => {
    const epic = cloneEpic(goodFloorEpic());
    (epic as { hard_gate?: unknown }).hard_gate = 42;
    expect(() => lintFloorEpic(epic, PERSONA_NAMES)).not.toThrow();
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('schema');
  });

  it('flags a non-array human_gates as a schema violation instead of throwing', () => {
    const epic = cloneEpic(goodFloorEpic());
    (epic as { human_gates?: unknown }).human_gates = 'defer to playtester';
    expect(() => lintFloorEpic(epic, PERSONA_NAMES)).not.toThrow();
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('schema');
  });

  it('flags a non-array non_goals as a schema violation instead of throwing', () => {
    const epic = cloneEpic(goodFloorEpic());
    (epic as { non_goals?: unknown }).non_goals = { note: 'not an array' };
    expect(() => lintFloorEpic(epic, PERSONA_NAMES)).not.toThrow();
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('schema');
  });

  it('flags a non_goals array containing a non-string element as a schema violation', () => {
    const epic = cloneEpic(goodFloorEpic());
    (epic as { non_goals?: unknown }).non_goals = [42];
    expect(() => lintFloorEpic(epic, PERSONA_NAMES)).not.toThrow();
    const violations = lintFloorEpic(epic, PERSONA_NAMES);
    expect(violations.map((v) => v.code)).toContain('schema');
  });
});

describe('outputPathViolation', () => {
  it('returns null when the file lives at the canonical path for its epic_id', () => {
    const epic = goodFloorEpic();
    expect(
      outputPathViolation(
        'docs/knowledge/epics/floor-9-example-completion/floor-9-example-completion.epic.json',
        epic,
      ),
    ).toBeNull();
  });

  it('returns a violation when the file lives outside its canonical epic_id path', () => {
    const epic = goodFloorEpic();
    const violation = outputPathViolation('docs/knowledge/epics/wrong-location.epic.json', epic);
    expect(violation?.code).toBe('output-path-mismatch');
  });
});

describe('floor-epic-lint.ts CLI (direct execution)', () => {
  // Spawn the local tsx binary directly (not via `npx`) — `spawnSync('npx', ...)`
  // throws ENOENT on Windows because `npx` resolves to `npx.cmd` there, and
  // `npx tsx` can also silently fetch a different tsx version than the pinned
  // devDependency. See tests/unit/aggregate-report-body-limit.test.ts for the
  // same tsx-binary resolution pattern.
  const isWindows = process.platform === 'win32';
  const repoRoot = path.resolve(process.cwd());
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', isWindows ? 'tsx.cmd' : 'tsx');
  const scriptPath = path.join(repoRoot, 'scripts/agent/epics/floor-epic-lint.ts');

  it('actually runs main() when invoked directly, printing OK for a compliant epic at its canonical path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'floor-epic-lint-'));
    const epicId = 'floor-9-example-completion';
    const epicDir = path.join(dir, 'docs', 'knowledge', 'epics', epicId);
    mkdirSync(epicDir, { recursive: true });
    const epicPath = path.join(epicDir, `${epicId}.epic.json`);
    writeFileSync(epicPath, JSON.stringify(goodFloorEpic(), null, 2));
    const relativePath = path.join('docs', 'knowledge', 'epics', epicId, `${epicId}.epic.json`);
    const result = spawnSync(tsxBin, [scriptPath, relativePath], {
      cwd: dir,
      encoding: 'utf8',
      shell: isWindows,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${relativePath}: OK`);
  });

  it('exits non-zero and reports output-path-mismatch when invoked on a non-canonical path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'floor-epic-lint-'));
    const epicPath = path.join(dir, 'wrong-location.epic.json');
    writeFileSync(epicPath, JSON.stringify(goodFloorEpic(), null, 2));
    const result = spawnSync(tsxBin, [scriptPath, epicPath], {
      cwd: dir,
      encoding: 'utf8',
      shell: isWindows,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('output-path-mismatch');
  });
});
