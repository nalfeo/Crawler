import { describe, expect, it } from 'vitest';
import {
  addItem,
  clearQueue,
  createEmptyQueue,
  deserializeQueue,
  getItem,
  getSelectedItem,
  primaryActionLabel,
  removeItem,
  selectItem,
  serializeQueue,
  slugify,
  stageActiveStep,
  stepperFor,
  updateItem,
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
    const next = updateItem(state, 'item-1', { stage: 'promoted', briefPath: 'briefs/x.yaml' });
    expect(getItem(next, 'item-1')!.stage).toBe('promoted');
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
    expect(stageActiveStep('candidates')).toBe(1);
    expect(stageActiveStep('promoted')).toBe(3);
    expect(stageActiveStep('variants')).toBe(4);
    expect(stageActiveStep('approved')).toBe(5);
    expect(stageActiveStep('done')).toBe(6);
  });

  it('marks done steps before the active one and flags busy stages', () => {
    const cells = stepperFor('generating');
    expect(cells[0]!.status).toBe('done');
    expect(cells[3]!.status).toBe('active');
    expect(cells[3]!.busy).toBe(true);
    expect(cells[4]!.status).toBe('todo');
  });

  it('marks every step done at the terminal stage', () => {
    expect(stepperFor('done').every((c) => c.status === 'done')).toBe(true);
  });

  it('exposes a contextual primary action label', () => {
    expect(primaryActionLabel('draft')).toBe('Synthesize');
    expect(primaryActionLabel('promoted')).toBe('Generate run');
    expect(primaryActionLabel('approved')).toBe('Tag (generate metadata)');
    expect(primaryActionLabel('synthesizing')).toBeNull();
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
    expect(restored.items[0]?.generationRequestedAt).toBeNull();
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
