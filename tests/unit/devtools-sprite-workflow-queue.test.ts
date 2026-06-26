import { describe, expect, it } from 'vitest';
import {
  addItem,
  candidateForceEligible,
  clearQueue,
  createEmptyQueue,
  deserializeQueue,
  describeGenerationProgress,
  failingSensors,
  formatGenerationElapsed,
  formatSensorResult,
  getItem,
  getSelectedItem,
  primaryActionLabel,
  removeItem,
  runHasSensorFailures,
  selectItem,
  sensorSummary,
  serializeQueue,
  slugify,
  stageActiveStep,
  stepperFor,
  updateItem,
  GENERATION_QUEUED_STALL_HINT_MS,
  GENERATION_SYNC_STALL_HINT_MS,
  type QueueRun,
  type QueueRunCandidate,
  type QueueSensorResult,
  type QueueState,
} from '../../src/devtools/sprite-workflow-queue.js';

describe('slugify', () => {
  it('kebab-cases a multi-word brief', () => {
    expect(slugify('Purple Potion Bottle')).toBe('purple-potion-bottle');
  });

  it('trims, collapses punctuation, and strips edges', () => {
    expect(slugify('  Fire!! Sword___MK2  ')).toBe('fire-sword-mk2');
  });

  it('caps length at 64 chars without a trailing dash', () => {
    const long = 'a'.repeat(70) + ' tail';
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns empty string for punctuation-only input', () => {
    expect(slugify('  ***  ')).toBe('');
  });
});

describe('addItem', () => {
  it('appends a draft item, selects it, and increments seq', () => {
    const state = addItem(createEmptyQueue(), 'Purple Potion Bottle');
    expect(state.items).toHaveLength(1);
    const item = state.items[0]!;
    expect(item.id).toBe('item-1');
    expect(item.seq).toBe(1);
    expect(item.brief).toBe('Purple Potion Bottle');
    expect(item.kebabName).toBe('purple-potion-bottle');
    expect(item.stage).toBe('draft');
    expect(item.requestedType).toBe('auto');
    expect(item.resolvedType).toBeNull();
    expect(state.selectedId).toBe('item-1');
    expect(state.nextSeq).toBe(2);
  });

  it('resolves explicit type immediately', () => {
    const state = addItem(createEmptyQueue(), 'Purple Potion Bottle', 'item');
    expect(state.items[0]!.requestedType).toBe('item');
    expect(state.items[0]!.resolvedType).toBe('item');
  });

  it('rejects briefs that do not normalise to a slug', () => {
    const empty = createEmptyQueue();
    expect(addItem(empty, '   ')).toBe(empty);
    expect(addItem(empty, '!!!')).toBe(empty);
  });

  it('keeps unique sequential ids across adds', () => {
    let state = addItem(createEmptyQueue(), 'one');
    state = addItem(state, 'two');
    expect(state.items.map((i) => i.id)).toEqual(['item-1', 'item-2']);
    expect(state.selectedId).toBe('item-2');
  });
});

describe('updateItem / getItem / getSelectedItem', () => {
  it('patches a single item by id', () => {
    const state = addItem(createEmptyQueue(), 'Purple Potion Bottle');
    const next = updateItem(state, 'item-1', { stage: 'sheet', briefPath: 'briefs/x.yaml' });
    expect(getItem(next, 'item-1')!.stage).toBe('sheet');
    expect(getItem(next, 'item-1')!.briefPath).toBe('briefs/x.yaml');
  });

  it('returns the same reference when id is unknown', () => {
    const state = addItem(createEmptyQueue(), 'Purple Potion Bottle');
    expect(updateItem(state, 'missing', { stage: 'done' })).toBe(state);
  });

  it('resolves the selected item', () => {
    const state = addItem(addItem(createEmptyQueue(), 'one'), 'two');
    expect(getSelectedItem(state)!.id).toBe('item-2');
  });
});

describe('removeItem', () => {
  it('removes and reselects the last remaining item', () => {
    let state = addItem(createEmptyQueue(), 'one');
    state = addItem(state, 'two');
    state = selectItem(state, 'item-1');
    const next = removeItem(state, 'item-1');
    expect(next.items.map((i) => i.id)).toEqual(['item-2']);
    expect(next.selectedId).toBe('item-2');
  });

  it('clears selection when the queue empties', () => {
    const state = addItem(createEmptyQueue(), 'one');
    const next = removeItem(state, 'item-1');
    expect(next.items).toHaveLength(0);
    expect(next.selectedId).toBeNull();
  });
});

describe('selectItem / clearQueue', () => {
  it('ignores selecting an unknown id', () => {
    const state = addItem(createEmptyQueue(), 'one');
    expect(selectItem(state, 'nope')).toBe(state);
  });

  it('clears items but preserves nextSeq monotonicity', () => {
    let state = addItem(createEmptyQueue(), 'one');
    state = addItem(state, 'two');
    const cleared = clearQueue(state);
    expect(cleared.items).toHaveLength(0);
    expect(cleared.selectedId).toBeNull();
    expect(cleared.nextSeq).toBe(3);
  });
});

describe('stage helpers', () => {
  it('maps stages to the active stepper milestone', () => {
    expect(stageActiveStep('draft')).toBe(0);
    expect(stageActiveStep('synthesizing')).toBe(0);
    expect(stageActiveStep('candidates')).toBe(1);
    expect(stageActiveStep('generating')).toBe(2);
    expect(stageActiveStep('sheet')).toBe(3);
    expect(stageActiveStep('postprocessing')).toBe(3);
    expect(stageActiveStep('postprocessed')).toBe(4);
    expect(stageActiveStep('judging')).toBe(4);
    expect(stageActiveStep('variants')).toBe(5);
    expect(stageActiveStep('approved')).toBe(6);
    expect(stageActiveStep('tagging')).toBe(6);
    expect(stageActiveStep('done')).toBe(7);
  });

  it('marks done steps before the active one and flags the generating busy stage', () => {
    const cells = stepperFor('generating');
    expect(cells[0]!.status).toBe('done'); // Synthesize
    expect(cells[1]!.status).toBe('done'); // Choose
    expect(cells[2]!.status).toBe('active'); // Generate
    expect(cells[2]!.busy).toBe(true);
    expect(cells[3]!.status).toBe('todo'); // PostProcess
  });

  it('flags the postprocessing busy stage on the PostProcess step', () => {
    const cells = stepperFor('postprocessing');
    expect(cells[2]!.status).toBe('done'); // Generate
    expect(cells[3]!.status).toBe('active'); // PostProcess
    expect(cells[3]!.busy).toBe(true);
    expect(cells[4]!.status).toBe('todo'); // Judge
  });

  it('flags the judging busy stage on the Judge step', () => {
    const cells = stepperFor('judging');
    expect(cells[3]!.status).toBe('done'); // PostProcess
    expect(cells[4]!.status).toBe('active'); // Judge
    expect(cells[4]!.busy).toBe(true);
    expect(cells[5]!.status).toBe('todo'); // Approve
  });

  it('marks the sheet stage active on PostProcess without busy', () => {
    const cells = stepperFor('sheet');
    expect(cells[3]!.status).toBe('active');
    expect(cells[3]!.busy).toBe(false);
  });

  it('marks every step done at the terminal stage', () => {
    expect(stepperFor('done').every((c) => c.status === 'done')).toBe(true);
  });

  it('exposes a contextual primary action label', () => {
    expect(primaryActionLabel('draft')).toBe('Synthesize');
    expect(primaryActionLabel('candidates')).toBe('Generate run');
    expect(primaryActionLabel('sheet')).toBe('PostProcess');
    expect(primaryActionLabel('postprocessed')).toBe('Judge');
    expect(primaryActionLabel('approved')).toBe('Tag (generate metadata)');
    expect(primaryActionLabel('synthesizing')).toBeNull();
    expect(primaryActionLabel('generating')).toBeNull();
    expect(primaryActionLabel('variants')).toBeNull();
    expect(primaryActionLabel('done')).toBeNull();
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a populated queue', () => {
    let state = addItem(createEmptyQueue(), 'Purple Potion Bottle', 'item');
    state = updateItem(state, 'item-1', {
      stage: 'variants',
      resolvedType: 'item',
      candidates: [
        { id: 'purple-potion-bottle-v1', yamlPath: 'a.yaml', description: 'd', yaml: 'y' },
      ],
      chosenCandidatePath: 'a.yaml',
      briefPath: 'briefs/draft/items/purple-potion-bottle.yaml',
      generationRequestedAt: '2026-06-20T00:00:00.000Z',
      run: {
        briefId: 'purple-potion-bottle',
        runId: 'run-1',
        candidates: [
          {
            index: 0,
            score: 80,
            outOf: 100,
            passed: true,
            combinedPassed: true,
            judge: {
              passed: true,
              minScore: 4,
              styleMatch: 4,
              briefMatch: 5,
              readability: 4,
              rejectedBy: [],
            },
            sensors: [
              { sensor: 'dimensions-exact', ok: true, reason: null, pixelCount: null },
              {
                sensor: 'alpha-binary',
                ok: false,
                reason: '12 semi-transparent pixels',
                pixelCount: 12,
              },
            ],
          },
        ],
      },
    });
    const restored = deserializeQueue(serializeQueue(state));
    expect(restored).toEqual(state);
  });

  it('defaults run candidate judge to null when absent in stored data', () => {
    const raw = JSON.stringify({
      items: [
        {
          id: 'item-1',
          seq: 1,
          brief: 'Purple Potion Bottle',
          stage: 'variants',
          run: {
            briefId: 'purple-potion-bottle',
            runId: 'run-1',
            candidates: [{ index: 0, score: 80, outOf: 100, passed: true, combinedPassed: false }],
          },
        },
      ],
      selectedId: 'item-1',
      nextSeq: 2,
    });
    const restored = deserializeQueue(raw);
    expect(restored.items[0]?.run?.candidates[0]?.judge).toBeNull();
    expect(restored.items[0]?.run?.candidates[0]?.sensors).toEqual([]);
    expect(restored.items[0]?.generationRequestedAt).toBeNull();
    expect(restored.items[0]?.generationStartedAt).toBeNull();
  });

  it('preserves structured per-sensor breakdown and drops malformed sensor entries', () => {
    const raw = JSON.stringify({
      items: [
        {
          id: 'item-1',
          seq: 1,
          brief: 'Purple Potion Bottle',
          stage: 'variants',
          run: {
            briefId: 'purple-potion-bottle',
            runId: 'run-1',
            candidates: [
              {
                index: 0,
                score: 1,
                outOf: 2,
                passed: false,
                combinedPassed: false,
                sensors: [
                  { sensor: 'dimensions-exact', ok: true },
                  { sensor: 'alpha-binary', ok: false, reason: '12 stray pixels', pixelCount: 12 },
                  { ok: false, reason: 'missing sensor name' },
                  'garbage',
                  null,
                  { sensor: 'palette-membership', ok: false, reason: 7, pixelCount: 'x' },
                ],
              },
            ],
          },
        },
      ],
      selectedId: 'item-1',
      nextSeq: 2,
    });
    const sensors = deserializeQueue(raw).items[0]?.run?.candidates[0]?.sensors;
    expect(sensors).toEqual([
      { sensor: 'dimensions-exact', ok: true, reason: null, pixelCount: null },
      { sensor: 'alpha-binary', ok: false, reason: '12 stray pixels', pixelCount: 12 },
      { sensor: 'palette-membership', ok: false, reason: null, pixelCount: null },
    ]);
  });

  it('returns an empty queue for garbage input', () => {
    expect(deserializeQueue('not json')).toEqual(createEmptyQueue());
    expect(deserializeQueue(null)).toEqual(createEmptyQueue());
    expect(deserializeQueue('123')).toEqual(createEmptyQueue());
  });

  it('drops malformed items and recomputes nextSeq', () => {
    const raw = JSON.stringify({
      items: [
        { id: 'item-3', seq: 3, brief: 'good', stage: 'draft' },
        { seq: 'bad' },
        { id: 'item-1', brief: 'no-seq' },
        null,
      ],
      selectedId: 'item-3',
      nextSeq: 1,
    });
    const state = deserializeQueue(raw);
    expect(state.items.map((i) => i.id)).toEqual(['item-3']);
    expect(state.nextSeq).toBe(4);
    expect(state.selectedId).toBe('item-3');
  });

  it('falls back to the last item when persisted selection is invalid', () => {
    const raw = JSON.stringify({
      items: [{ id: 'item-1', seq: 1, brief: 'a', stage: 'draft' }],
      selectedId: 'ghost',
      nextSeq: 2,
    });
    expect(deserializeQueue(raw).selectedId).toBe('item-1');
  });

  it('coerces invalid stage and requestedType to safe defaults', () => {
    const raw = JSON.stringify({
      items: [{ id: 'item-1', seq: 1, brief: 'a', stage: 'bogus', requestedType: 'nope' }],
      nextSeq: 2,
    });
    const item = deserializeQueue(raw).items[0]!;
    expect(item.stage).toBe('draft');
    expect(item.requestedType).toBe('auto');
  });
});

describe('createEmptyQueue', () => {
  it('starts empty with seq 1', () => {
    const state: QueueState = createEmptyQueue();
    expect(state).toEqual({ items: [], selectedId: null, nextSeq: 1 });
  });
});

describe('generationStartedAt field', () => {
  it('defaults to null for a newly added item', () => {
    const state = addItem(createEmptyQueue(), 'Slime Rat');
    expect(state.items[0]?.generationStartedAt).toBeNull();
  });

  it('round-trips through serialize/deserialize', () => {
    const added = addItem(createEmptyQueue(), 'Slime Rat');
    const id = added.items[0]!.id;
    const state = updateItem(added, id, { generationStartedAt: '2026-06-25T12:00:00.000Z' });
    const restored = deserializeQueue(serializeQueue(state));
    expect(restored.items[0]?.generationStartedAt).toBe('2026-06-25T12:00:00.000Z');
  });
});

describe('formatGenerationElapsed', () => {
  it('clamps non-finite and non-positive input to 0s', () => {
    expect(formatGenerationElapsed(0)).toBe('0s');
    expect(formatGenerationElapsed(-5_000)).toBe('0s');
    expect(formatGenerationElapsed(Number.NaN)).toBe('0s');
    expect(formatGenerationElapsed(Number.POSITIVE_INFINITY)).toBe('0s');
  });

  it('renders seconds under a minute', () => {
    expect(formatGenerationElapsed(999)).toBe('0s');
    expect(formatGenerationElapsed(45_000)).toBe('45s');
    expect(formatGenerationElapsed(59_999)).toBe('59s');
  });

  it('renders minutes and zero-padded seconds under an hour', () => {
    expect(formatGenerationElapsed(60_000)).toBe('1m 00s');
    expect(formatGenerationElapsed(133_000)).toBe('2m 13s');
  });

  it('renders hours and zero-padded minutes past an hour', () => {
    expect(formatGenerationElapsed(3_600_000)).toBe('1h 00m');
    expect(formatGenerationElapsed(3_780_000)).toBe('1h 03m');
  });
});

describe('describeGenerationProgress', () => {
  it('omits the poll counter on the synchronous path', () => {
    const line = describeGenerationProgress({
      brief: 'Slime Rat',
      elapsedMs: 10_000,
      pollAttempts: null,
      queueBackend: 'noop',
    });
    expect(line).toContain('Generating "Slime Rat"');
    expect(line).toContain('10s elapsed');
    expect(line).not.toContain('polled');
  });

  it('shows the poll counter and backend on the queued path', () => {
    const line = describeGenerationProgress({
      brief: 'Slime Rat',
      elapsedMs: 5_000,
      pollAttempts: 3,
      queueBackend: 'azure-queue',
    });
    expect(line).toContain('polled 3×');
    expect(line).toContain('queue: azure-queue');
  });

  it('appends the worker hint once the queued path passes the stall threshold', () => {
    const before = describeGenerationProgress({
      brief: 'Slime Rat',
      elapsedMs: GENERATION_QUEUED_STALL_HINT_MS - 1,
      pollAttempts: 12,
      queueBackend: 'azure-queue',
    });
    const after = describeGenerationProgress({
      brief: 'Slime Rat',
      elapsedMs: GENERATION_QUEUED_STALL_HINT_MS,
      pollAttempts: 12,
      queueBackend: 'azure-queue',
    });
    expect(before).not.toContain('sprites:worker');
    expect(after).toContain('npm run sprites:worker');
  });

  it('suppresses the generic CLI worker hint when the launch-button hint is shown', () => {
    const line = describeGenerationProgress({
      brief: 'Slime Rat',
      elapsedMs: GENERATION_QUEUED_STALL_HINT_MS,
      pollAttempts: 12,
      queueBackend: 'azure-queue',
      suppressQueuedStallHint: true,
    });
    // The in-app "Launch worker" hint is the single remediation in this case,
    // so the generic `npm run sprites:worker` CLI hint must not also appear.
    expect(line).not.toContain('sprites:worker');
    // The live elapsed/poll status line is still rendered.
    expect(line).toContain('polled 12×');
  });

  it('appends the provider hint once the sync path passes the stall threshold', () => {
    const before = describeGenerationProgress({
      brief: 'Slime Rat',
      elapsedMs: GENERATION_SYNC_STALL_HINT_MS - 1,
      pollAttempts: null,
      queueBackend: 'noop',
    });
    const after = describeGenerationProgress({
      brief: 'Slime Rat',
      elapsedMs: GENERATION_SYNC_STALL_HINT_MS,
      pollAttempts: null,
      queueBackend: 'noop',
    });
    expect(before).not.toContain('Cancel and retry');
    expect(after).toContain('Cancel and retry');
  });
});

function makeSensor(
  sensor: string,
  ok: boolean,
  reason: string | null = null,
  pixelCount: number | null = null,
): QueueSensorResult {
  return { sensor, ok, reason, pixelCount };
}

function makeCandidate(
  index: number,
  combinedPassed: boolean,
  sensors: QueueSensorResult[],
): QueueRunCandidate {
  return {
    index,
    score: 0,
    outOf: 0,
    passed: sensors.every((sensor) => sensor.ok),
    combinedPassed,
    judge: null,
    sensors,
  };
}

describe('failingSensors', () => {
  it('returns only the failing sensors, preserving source order', () => {
    const candidate = makeCandidate(0, false, [
      makeSensor('silhouette', true),
      makeSensor('transparency', false, 'bg-not-transparent', 1234),
      makeSensor('edge', false, 'edge-bleed'),
    ]);
    expect(failingSensors(candidate).map((sensor) => sensor.sensor)).toEqual([
      'transparency',
      'edge',
    ]);
  });

  it('returns an empty array when every sensor passed', () => {
    const candidate = makeCandidate(0, true, [makeSensor('silhouette', true)]);
    expect(failingSensors(candidate)).toEqual([]);
  });
});

describe('formatSensorResult', () => {
  it('labels a passing sensor', () => {
    expect(formatSensorResult(makeSensor('silhouette', true))).toBe('silhouette: passed');
  });

  it('includes the reason and the pixelCount magnitude hint when failed', () => {
    expect(formatSensorResult(makeSensor('transparency', false, 'bg-not-transparent', 1234))).toBe(
      'transparency: bg-not-transparent (1234px)',
    );
  });

  it('omits the pixel hint when pixelCount is null', () => {
    expect(formatSensorResult(makeSensor('edge', false, 'edge-bleed'))).toBe('edge: edge-bleed');
  });

  it('falls back to "failed" when a failed sensor has no reason', () => {
    expect(formatSensorResult(makeSensor('edge', false, null, 42))).toBe('edge: failed (42px)');
  });
});

describe('sensorSummary', () => {
  it('returns null when the candidate carries no sensor detail', () => {
    expect(sensorSummary(makeCandidate(0, true, []))).toBeNull();
  });

  it('reports zero failures when all sensors pass', () => {
    const summary = sensorSummary(
      makeCandidate(0, true, [makeSensor('silhouette', true), makeSensor('edge', true)]),
    );
    expect(summary).toEqual({ total: 2, failed: 0, failingLabels: [] });
  });

  it('counts failures and renders their labels in source order', () => {
    const summary = sensorSummary(
      makeCandidate(0, false, [
        makeSensor('silhouette', true),
        makeSensor('transparency', false, 'bg-not-transparent', 1234),
        makeSensor('edge', false, 'edge-bleed'),
      ]),
    );
    expect(summary).toEqual({
      total: 3,
      failed: 2,
      failingLabels: ['transparency: bg-not-transparent (1234px)', 'edge: edge-bleed'],
    });
  });
});

describe('candidateForceEligible', () => {
  it('is true for a non-combined-pass candidate with a failing sensor', () => {
    expect(
      candidateForceEligible(
        makeCandidate(0, false, [makeSensor('transparency', false, 'bg-not-transparent')]),
      ),
    ).toBe(true);
  });

  it('is false when the candidate already combined-passed', () => {
    expect(
      candidateForceEligible(
        makeCandidate(0, true, [makeSensor('transparency', false, 'bg-not-transparent')]),
      ),
    ).toBe(false);
  });

  it('is false when no sensor failed (a non-sensor gate)', () => {
    expect(candidateForceEligible(makeCandidate(0, false, [makeSensor('edge', true)]))).toBe(false);
  });

  it('is false when there is no sensor detail at all', () => {
    expect(candidateForceEligible(makeCandidate(0, false, []))).toBe(false);
  });
});

describe('runHasSensorFailures', () => {
  function makeRun(candidates: QueueRunCandidate[]): QueueRun {
    return { briefId: 'brief', runId: 'run', candidates };
  }

  it('is true when any candidate is force-eligible', () => {
    const run = makeRun([
      makeCandidate(0, true, [makeSensor('silhouette', true)]),
      makeCandidate(1, false, [makeSensor('transparency', false, 'bg-not-transparent')]),
    ]);
    expect(runHasSensorFailures(run)).toBe(true);
  });

  it('is false when every candidate passes its sensors', () => {
    const run = makeRun([
      makeCandidate(0, true, [makeSensor('silhouette', true)]),
      makeCandidate(1, true, [makeSensor('edge', true)]),
    ]);
    expect(runHasSensorFailures(run)).toBe(false);
  });

  it('is false for a run with no candidates', () => {
    expect(runHasSensorFailures(makeRun([]))).toBe(false);
  });
});
