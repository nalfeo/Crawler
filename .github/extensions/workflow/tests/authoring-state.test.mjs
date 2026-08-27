import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKFLOW_STAGES,
  addRequest,
  approvalPatch,
  editRequestItem,
  mergeChangedItem,
  metadataDonePatch,
  normalizeQueue,
  recoverQueue,
  resetDownstreamForBriefChange,
  rewindItem,
  updateItem,
} from '../lib/authoring-state.mjs';
import { normalizeCategoryOverride } from '../lib/request-template.mjs';

function item(seq, patch = {}) {
  return {
    id: `item-${seq}`,
    seq,
    name: `asset-${seq}`,
    brief: 'a test sprite',
    requestedType: 'prop',
    sizeVariant: 'default',
    kebabName: `asset-${seq}`,
    stage: 'draft',
    candidates: [],
    chosenCandidatePath: null,
    briefPath: null,
    run: null,
    generationRequestedAt: null,
    generationStartedAt: null,
    ...patch,
  };
}

test('load-time recovery returns interrupted transient stages while preserving durable queue state', () => {
  const state = recoverQueue(
    normalizeQueue({
      items: WORKFLOW_STAGES.map((stage, index) =>
        item(index + 1, {
          stage,
          devToolsOnly: stage,
          ...(stage === 'generating' ? { generationRequestedAt: '2026-08-21T12:00:00.000Z' } : {}),
        }),
      ),
      selectedId: 'item-13',
      nextSeq: 14,
    }),
  );

  assert.deepEqual(
    state.items.map((entry) => entry.stage),
    [
      'draft',
      'draft',
      'candidates',
      'generating',
      'sheet',
      'sheet',
      'postprocessed',
      'sheet',
      'variants',
      'approved',
      'checked-in',
      'approved',
      'done',
    ],
  );
  assert.equal(state.items[12].devToolsOnly, 'done');
});

test('recovery keeps queued Azure generation pollable but recovers an interrupted local request', () => {
  const state = recoverQueue(
    normalizeQueue({
      items: [
        item(1, { stage: 'generating', generationRequestedAt: '2026-08-21T12:00:00.000Z' }),
        item(2, { stage: 'generating', generationStartedAt: '2026-08-21T12:00:00.000Z' }),
      ],
      selectedId: 'item-1',
      nextSeq: 3,
    }),
  );
  assert.equal(state.items[0].stage, 'generating');
  assert.equal(state.items[1].stage, 'candidates');
  assert.equal(state.items[1].generationStartedAt, null);
});

test('recovery keeps post-processed variants from a re-run instead of forcing another sheet pass', () => {
  const run = {
    briefId: 'asset-1',
    runId: 'run-1',
    candidates: [{ index: 0, score: 0, outOf: 0, passed: false, combinedPassed: false }],
  };
  const state = recoverQueue(
    normalizeQueue({
      items: [
        item(1, { stage: 'postprocessing', run }),
        item(2, { stage: 'judging', run }),
        item(3, { stage: 'postprocessing', run: { ...run, candidates: [] } }),
      ],
      selectedId: 'item-1',
      nextSeq: 4,
    }),
  );

  // Matches src/devtools/sprite-workflow-queue.ts: a re-postprocess retains its
  // sliced variants; only a first run has nothing but the raw sheet.
  assert.equal(state.items[0].stage, 'postprocessed');
  assert.equal(state.items[1].stage, 'postprocessed');
  assert.equal(state.items[2].stage, 'sheet');
});

test('normalization never rewinds a transient stage, so a merge write cannot persist a recovery', () => {
  const remote = {
    items: [
      item(1, { stage: 'postprocessing', run: { briefId: 'a', runId: 'r', candidates: [] } }),
      item(2, { stage: 'synthesizing' }),
      item(3, { stage: 'draft' }),
    ],
    selectedId: 'item-3',
    nextSeq: 4,
  };
  const normalized = normalizeQueue(remote);
  assert.deepEqual(
    normalized.items.map((entry) => entry.stage),
    ['postprocessing', 'synthesizing', 'draft'],
  );

  // A canvas that advances item-3 while DevTools synthesizes item-2 and
  // post-processes item-1 must write both remote items back untouched.
  const local = updateItem(recoverQueue(normalized), 'item-3', { stage: 'synthesizing' });
  const merged = mergeChangedItem(normalized, local, 'item-3', { stage: 'synthesizing' });
  assert.deepEqual(
    merged.items.map((entry) => entry.stage),
    ['postprocessing', 'synthesizing', 'synthesizing'],
  );
});

test('normalization retains canonical requests with a name but no optional brief text', () => {
  const state = normalizeQueue({
    items: [item(1, { name: 'directional-walk', brief: '' })],
    selectedId: 'item-1',
    nextSeq: 2,
  });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].name, 'directional-walk');
  assert.equal(state.items[0].brief, '');
});

test('request creation rejects a name that cannot become a consumer id', () => {
  assert.throws(
    () => addRequest(normalizeQueue({ items: [], selectedId: null, nextSeq: 1 }), { name: '!!!' }),
    /letters or numbers/,
  );
});

test('request creation persists the local counterpart of GitHub request context fields', () => {
  const { item } = addRequest(normalizeQueue({ items: [], selectedId: null, nextSeq: 1 }), {
    name: 'floor-two-goblin',
    type: 'enemy',
    floor: 2,
    floorId: 'floor2',
    familyId: 'goblins',
    mobRole: 'elite',
    injectionOverrides: {
      floor: 'cold blue stone',
      family: 'patched green leather',
      category: 'orthographic enemy construction',
    },
    priority: 'high',
    requester: 'sprite-author',
  });

  assert.equal(item.floorId, 'floor2');
  assert.equal(item.floor, 2);
  assert.equal(item.familyId, 'goblins');
  assert.equal(item.mobRole, 'elite');
  assert.deepEqual(item.injectionOverrides, {
    floor: 'cold blue stone',
    family: 'patched green leather',
    category: 'orthographic enemy construction',
  });
  assert.equal(item.priority, 'high');
  assert.equal(item.requester, 'sprite-author');
});

test('rewinds only pointers while durable generated artifacts remain addressable', () => {
  const original = item(1, {
    stage: 'checked-in',
    candidates: [{ id: 'asset-1', yamlPath: 'briefs/draft/asset-1.yaml', yaml: 'name: asset-1' }],
    chosenCandidatePath: 'briefs/draft/asset-1.yaml',
    briefPath: 'briefs/draft/asset-1.yaml',
    run: { briefId: 'asset-1', runId: 'run-1', candidates: [] },
    approvedAssetPath: 'public/assets/generated/asset-1.png',
  });
  const sheet = rewindItem(original, 'sheet');
  assert.equal(sheet.stage, 'sheet');
  assert.equal(sheet.run.runId, 'run-1');
  assert.equal(sheet.approvedAssetPath, null);
  const brief = rewindItem(original, 'brief');
  assert.equal(brief.stage, 'draft');
  assert.equal(brief.run, null);
  assert.equal(brief.briefPath, null);
  assert.equal(original.run.runId, 'run-1');
});

test('editing a chosen promoted brief clears stale downstream artifacts', () => {
  const original = item(1, {
    stage: 'done',
    chosenCandidatePath: 'briefs/draft/asset-1.yaml',
    briefPath: 'briefs/asset-1.yaml',
    run: { briefId: 'asset-1', runId: 'run-1', candidates: [] },
    generationRequestedAt: '2026-08-21T12:00:00.000Z',
    approvedAssetPath: 'public/assets/generated/asset-1.png',
    metadataSummary: 'Tagged',
  });

  const reset = resetDownstreamForBriefChange(original, original.chosenCandidatePath);
  assert.equal(reset.stage, 'candidates');
  assert.equal(reset.briefPath, null);
  assert.equal(reset.run, null);
  assert.equal(reset.generationRequestedAt, null);
  assert.equal(reset.approvedAssetPath, null);
  assert.equal(reset.metadataSummary, null);
});

test('editing prompt fields resets downstream state and updates the consumer id', () => {
  const original = item(1, {
    stage: 'done',
    name: 'old-name',
    kebabName: 'old-name',
    candidates: [{ yamlPath: 'briefs/draft/old-name.yaml' }],
    chosenCandidatePath: 'briefs/draft/old-name.yaml',
    briefPath: 'briefs/old-name.yaml',
    run: { briefId: 'old-name', runId: 'run-1', candidates: [] },
    approvedAssetPath: 'public/assets/generated/old-name.png',
  });
  const edited = editRequestItem(original, {
    name: 'New Name',
    brief: 'new direction',
    injectionOverrides: { floor: 'new floor injection' },
  });
  assert.equal(edited.kebabName, 'new-name');
  assert.equal(edited.stage, 'draft');
  assert.deepEqual(edited.candidates, []);
  assert.equal(edited.chosenCandidatePath, null);
  assert.equal(edited.briefPath, null);
  assert.equal(edited.run, null);
  assert.equal(edited.approvedAssetPath, null);
  assert.deepEqual(edited.injectionOverrides, { floor: 'new floor injection' });
});

test('editing metadata-only fields preserves synthesized state', () => {
  const original = item(1, {
    stage: 'done',
    run: { briefId: 'asset-1', runId: 'run-1', candidates: [] },
  });
  const edited = editRequestItem(original, {
    priority: 'high',
    requester: 'Ada',
    injectionOverrides: {},
  });
  assert.equal(edited.stage, 'done');
  assert.equal(edited.run.runId, 'run-1');
  assert.equal(edited.priority, 'high');
  assert.equal(edited.requester, 'Ada');
});

test('unchanged edit after concrete-type creation preserves generated and approved state', () => {
  const categoryDesignLanguage = { character: 'canonical character language' };
  const created = addRequest(
    { items: [], selectedId: null, nextSeq: 1 },
    {
      name: 'main player',
      brief: 'Facing south.',
      type: 'character',
      injectionOverrides: {
        category: normalizeCategoryOverride(
          'canonical character language',
          'character',
          categoryDesignLanguage,
        ),
      },
    },
  ).item;
  const completed = {
    ...created,
    stage: 'done',
    candidates: [{ id: 'main-player', yamlPath: 'briefs/draft/main-player.yaml' }],
    chosenCandidatePath: 'briefs/draft/main-player.yaml',
    briefPath: 'briefs/main-player.yaml',
    run: { briefId: 'main-player', runId: 'run-1', candidates: [] },
    approvedAssetPath: 'public/assets/generated/main-player.png',
  };

  const edited = editRequestItem(completed, {
    name: completed.name,
    brief: completed.brief,
    requestedType: completed.requestedType,
    sizeVariant: completed.sizeVariant,
    floor: completed.floor,
    floorId: completed.floorId,
    familyId: completed.familyId,
    mobRole: completed.mobRole,
    injectionOverrides: {
      category: normalizeCategoryOverride(
        'canonical character language',
        'character',
        categoryDesignLanguage,
      ),
    },
  });

  assert.equal(edited.stage, 'done');
  assert.equal(edited.run.runId, 'run-1');
  assert.equal(edited.approvedAssetPath, 'public/assets/generated/main-player.png');
  assert.equal(edited.candidates.length, 1);
});

test('editing an auto-typed request preserves its canonical unclassified type', () => {
  const original = addRequest(
    { items: [], selectedId: null, nextSeq: 1 },
    { name: 'unclassified asset' },
  ).item;
  const edited = editRequestItem(original, {
    requestedType: 'auto',
    priority: 'high',
  });
  assert.equal(edited.requestedType, 'auto');
  assert.equal(edited.resolvedType, null);
  assert.equal(edited.priority, 'high');
  assert.equal(edited.stage, 'draft');
});

test('auto-typed requests cannot persist category guidance before classification', () => {
  const created = addRequest(
    { items: [], selectedId: null, nextSeq: 1 },
    {
      name: 'unclassified asset',
      injectionOverrides: { floor: 'floor guidance', category: 'enemy guidance' },
    },
  ).item;
  assert.deepEqual(created.injectionOverrides, { floor: 'floor guidance' });

  const edited = editRequestItem(
    item(1, {
      requestedType: 'enemy',
      injectionOverrides: { category: 'enemy guidance' },
    }),
    { requestedType: 'auto' },
  );
  assert.equal(edited.requestedType, 'auto');
  assert.deepEqual(edited.injectionOverrides, {});
});

test('editing validates durable request fields at the state boundary', () => {
  const original = item(1);
  assert.throws(() => editRequestItem(original, { name: 123 }), /name must be a string/);
  assert.throws(() => editRequestItem(original, { name: '---' }), /letters or numbers/);
  assert.throws(() => editRequestItem(original, { requestedType: 'unknown' }), /known sprite type/);
  assert.throws(() => editRequestItem(original, { sizeVariant: 'huge' }), /known sprite footprint/);
  assert.throws(() => editRequestItem(original, { mobRole: 'miniboss' }), /mobRole/);
  assert.throws(() => editRequestItem(original, { priority: 'urgent' }), /priority/);
  assert.throws(() => editRequestItem(original, { floor: 0 }), /integer from 1 through 20/);
  assert.throws(() => editRequestItem(original, { floor: 21 }), /integer from 1 through 20/);
  assert.throws(
    () => editRequestItem(original, { injectionOverrides: 'category prose' }),
    /injectionOverrides must be an object/,
  );
  assert.throws(() => editRequestItem(original, { brief: 123 }), /brief must be a string/);
  assert.throws(
    () => editRequestItem(original, { requester: { name: 'Ada' } }),
    /requester must be a string or null/,
  );
});

test('icon requests remain icon requests through creation and editing', () => {
  const created = addRequest(
    { items: [], selectedId: null, nextSeq: 1 },
    { name: 'status icon', type: 'icon' },
  ).item;
  assert.equal(created.requestedType, 'icon');
  assert.equal(created.resolvedType, 'icon');

  const edited = editRequestItem(item(1), { requestedType: 'icon' });
  assert.equal(edited.requestedType, 'icon');
  assert.equal(edited.resolvedType, 'icon');
});

test('metadata completion preserves durable status honestly', () => {
  const result = metadataDonePatch(
    {
      provider: 'auto',
      processedCount: 1,
      changedCount: 1,
      rejectedCount: 0,
      queueCommit: { status: 'failed', error: 'push denied' },
    },
    'ok',
  );
  assert.equal(result.stage, 'done');
  assert.equal(result.queueDurability, 'failed');
  assert.match(result.metadataSummary, /push denied/);
});

test('approval records the canonical assets/queue commit outcome', () => {
  const result = approvalPatch(
    {
      assetPath: 'public/assets/generated/asset-1-var-0.png',
      queueCommit: { status: 'failed', error: 'push denied' },
    },
    0,
  );
  assert.equal(result.stage, 'approved');
  assert.equal(result.approvedAssetPath, 'public/assets/generated/asset-1-var-0.png');
  assert.equal(result.queueDurability, 'failed');
  assert.match(result.approvalSummary, /push denied/);
});

test('item-level merge retains remote DevTools items while applying the local item change', () => {
  const remote = {
    items: [item(1, { stage: 'done', devToolsOnly: 'keep' }), item(2, { stage: 'tagging' })],
    selectedId: 'item-2',
    nextSeq: 3,
  };
  const local = updateItem(
    addRequest(
      { items: [item(1)], selectedId: 'item-1', nextSeq: 2 },
      { name: 'asset-2', brief: 'new' },
    ).state,
    'item-2',
    { stage: 'candidates', candidates: [{ id: 'asset-2', yamlPath: 'briefs/draft/asset-2.yaml' }] },
  );
  const merged = mergeChangedItem(remote, local, 'item-2');
  assert.equal(merged.items.length, 2);
  assert.equal(merged.items.find((entry) => entry.id === 'item-1').devToolsOnly, 'keep');
  assert.equal(merged.items.find((entry) => entry.id === 'item-2').stage, 'candidates');
});

test('item-level merge retains concurrent same-item fields outside the explicit patch', () => {
  const remote = {
    items: [item(1, { stage: 'tagging', metadataSummary: 'written by DevTools' })],
    selectedId: 'item-1',
    nextSeq: 2,
  };
  const local = updateItem(normalizeQueue(remote), 'item-1', {
    stage: 'sheet',
    run: { briefId: 'asset-1', runId: 'run-1', candidates: [] },
  });
  const merged = mergeChangedItem(remote, local, 'item-1', {
    stage: 'sheet',
    run: { briefId: 'asset-1', runId: 'run-1', candidates: [] },
  });
  assert.equal(merged.items[0].stage, 'sheet');
  assert.equal(merged.items[0].metadataSummary, 'written by DevTools');
});

test('new request merge durably selects the newly created item when requested', () => {
  const remote = { items: [item(1)], selectedId: 'item-1', nextSeq: 2 };
  const added = addRequest(normalizeQueue(remote), { name: 'asset-2', brief: 'new request' });
  const merged = mergeChangedItem(remote, added.state, added.item.id, null, { select: true });
  assert.equal(merged.selectedId, 'item-2');
});

test('queue normalization and writes retain unknown top-level DevTools metadata', () => {
  const remote = {
    items: [item(1)],
    selectedId: 'item-1',
    nextSeq: 2,
    devToolsQueueMetadata: { recoveryVersion: 7 },
  };
  const normalized = normalizeQueue(remote);
  const merged = mergeChangedItem(remote, normalized, 'item-1', { stage: 'sheet' });
  assert.deepEqual(merged.devToolsQueueMetadata, { recoveryVersion: 7 });
});
