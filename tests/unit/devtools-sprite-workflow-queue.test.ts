import { describe, expect, it } from 'vitest';
import {
  addItem,
  approvedItemPatch,
  candidateForceEligible,
  candidateStatus,
  clearQueue,
  createEmptyQueue,
  describeJudgeSkipReason,
  deserializeQueue,
  describeGenerationProgress,
  failingSensors,
  formatGenerationElapsed,
  formatSensorResult,
  getItem,
  getSelectedItem,
  metadataDonePatch,
  metadataReadyBanner,
  applyMetadataTagResult,
  METADATA_BANNER_FAILED_COLOR,
  METADATA_BANNER_OK_COLOR,
  primaryActionLabel,
  recoverInterruptedItem,
  removeItem,
  restartToBriefPatch,
  restartToSheetPatch,
  runHasSensorFailures,
  selectItem,
  sensorSummary,
  serializeQueue,
  slugify,
  stageActiveStep,
  stepperFor,
  updateItem,
  isSizeVariant,
  SIZE_VARIANTS,
  DEFAULT_SIZE_VARIANT,
  GENERATION_QUEUED_STALL_HINT_MS,
  GENERATION_SYNC_STALL_HINT_MS,
  type CandidateStatusInput,
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
    expect(item.name).toBe('Purple Potion Bottle');
    expect(item.brief).toBe('');
    expect(item.kebabName).toBe('purple-potion-bottle');
    expect(item.stage).toBe('draft');
    expect(item.requestedType).toBe('auto');
    expect(item.resolvedType).toBeNull();
    expect(state.selectedId).toBe('item-1');
    expect(state.nextSeq).toBe(2);
  });

  it('keeps the name as identity and the brief as separate synthesis direction', () => {
    const state = addItem(
      createEmptyQueue(),
      'Skull Mace',
      'heavy two-handed, glowing green eye sockets',
    );
    const item = state.items[0]!;
    expect(item.name).toBe('Skull Mace');
    expect(item.brief).toBe('heavy two-handed, glowing green eye sockets');
    // The brief direction must NOT leak into the slug/identity.
    expect(item.kebabName).toBe('skull-mace');
  });

  it('falls back to the brief for the slug when no name is given', () => {
    const state = addItem(createEmptyQueue(), '', 'Purple Potion Bottle');
    const item = state.items[0]!;
    expect(item.name).toBe('Purple Potion Bottle');
    expect(item.kebabName).toBe('purple-potion-bottle');
  });

  it('resolves explicit type immediately', () => {
    const state = addItem(createEmptyQueue(), 'Purple Potion Bottle', '', 'item');
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

describe('sizeVariant', () => {
  it('exposes the canonical variant list with default first', () => {
    expect(SIZE_VARIANTS).toEqual(['default', 'wide', 'tall', 'large']);
    expect(DEFAULT_SIZE_VARIANT).toBe('default');
  });

  it('guards valid variants and rejects everything else', () => {
    for (const variant of SIZE_VARIANTS) {
      expect(isSizeVariant(variant)).toBe(true);
    }
    expect(isSizeVariant('huge')).toBe(false);
    expect(isSizeVariant('')).toBe(false);
    expect(isSizeVariant(undefined)).toBe(false);
    expect(isSizeVariant(2)).toBe(false);
  });

  it('defaults a newly added item to the default size', () => {
    const item = addItem(createEmptyQueue(), 'Purple Potion Bottle').items[0]!;
    expect(item.sizeVariant).toBe('default');
  });

  it('round-trips a non-default size through serialize/deserialize', () => {
    let state = addItem(createEmptyQueue(), 'Banner', '', 'item');
    state = updateItem(state, 'item-1', { sizeVariant: 'wide' });
    const restored = deserializeQueue(serializeQueue(state));
    expect(restored.items[0]!.sizeVariant).toBe('wide');
  });

  it('hydrates a missing or invalid persisted size to the default', () => {
    const raw = JSON.stringify({
      items: [
        { id: 'item-1', seq: 1, name: 'a', brief: 'a', stage: 'draft', requestedType: 'auto' },
        {
          id: 'item-2',
          seq: 2,
          name: 'b',
          brief: 'b',
          stage: 'draft',
          requestedType: 'auto',
          sizeVariant: 'bogus',
        },
      ],
      nextSeq: 3,
    });
    const items = deserializeQueue(raw).items;
    expect(items[0]!.sizeVariant).toBe('default');
    expect(items[1]!.sizeVariant).toBe('default');
  });
});

describe('recoverInterruptedItem', () => {
  const runWithVariants: QueueRun = {
    briefId: 'iron-sword',
    runId: 'run-1',
    candidates: [
      {
        index: 0,
        score: 3,
        outOf: 3,
        passed: true,
        combinedPassed: true,
        judge: null,
        sensors: [],
      },
    ],
  };

  const itemAt = (patch: Partial<Parameters<typeof updateItem>[2]>) => {
    const state = updateItem(addItem(createEmptyQueue(), 'Iron Sword'), 'item-1', patch);
    return state.items[0]!;
  };

  it('reverts synthesizing to draft when no candidates exist yet', () => {
    expect(recoverInterruptedItem(itemAt({ stage: 'synthesizing' })).stage).toBe('draft');
  });

  it('reverts synthesizing to candidates when a re-synth had candidates', () => {
    const item = itemAt({
      stage: 'synthesizing',
      candidates: [{ id: 'v1', yamlPath: 'a.yaml', description: 'd', yaml: 'y' }],
    });
    expect(recoverInterruptedItem(item).stage).toBe('candidates');
  });

  it('keeps a queued generation (server run resumes via polling)', () => {
    const item = itemAt({
      stage: 'generating',
      generationRequestedAt: '2026-06-27T00:00:00.000Z',
      generationStartedAt: '2026-06-27T00:00:00.000Z',
    });
    expect(recoverInterruptedItem(item)).toEqual(item);
  });

  it('reverts an interrupted synchronous generation to candidates and clears the timer', () => {
    const item = itemAt({
      stage: 'generating',
      generationRequestedAt: null,
      generationStartedAt: '2026-06-27T00:00:00.000Z',
    });
    const recovered = recoverInterruptedItem(item);
    expect(recovered.stage).toBe('candidates');
    expect(recovered.generationStartedAt).toBeNull();
  });

  it('reverts postprocessing to sheet when only the raw sheet exists', () => {
    const item = itemAt({
      stage: 'postprocessing',
      run: { briefId: 'iron-sword', runId: 'run-1', candidates: [] },
    });
    expect(recoverInterruptedItem(item).stage).toBe('sheet');
  });

  it('reverts a postprocessing re-run to postprocessed when variants already exist', () => {
    const item = itemAt({ stage: 'postprocessing', run: runWithVariants });
    expect(recoverInterruptedItem(item).stage).toBe('postprocessed');
  });

  it('reverts judging to postprocessed where Judge and Approve remain available', () => {
    const item = itemAt({ stage: 'judging', run: runWithVariants });
    expect(recoverInterruptedItem(item).stage).toBe('postprocessed');
  });

  it('reverts tagging to approved when no check-in metadata exists', () => {
    expect(recoverInterruptedItem(itemAt({ stage: 'tagging' })).stage).toBe('approved');
  });

  it('reverts tagging to checked-in when check-in metadata exists', () => {
    expect(
      recoverInterruptedItem(
        itemAt({
          stage: 'tagging',
          checkinBranch: 'assets/checkin-abc123',
          checkinIssueUrl: 'https://github.com/nalfeo/Crawler/issues/99',
        }),
      ).stage,
    ).toBe('checked-in');
  });

  it('reverts tagging to done when metadata already existed', () => {
    expect(
      recoverInterruptedItem(
        itemAt({
          stage: 'tagging',
          metadataSummary: 'Tagged via auto: processed=1, changed=1, rejected=0',
          checkinIssueUrl: 'https://github.com/nalfeo/Crawler/issues/99',
        }),
      ).stage,
    ).toBe('done');
  });

  it('leaves stable stages untouched', () => {
    for (const stage of [
      'draft',
      'candidates',
      'sheet',
      'postprocessed',
      'variants',
      'approved',
      'checked-in',
      'done',
    ] as const) {
      const item = itemAt({ stage });
      expect(recoverInterruptedItem(item)).toEqual(item);
    }
  });

  it('is applied by deserializeQueue so a persisted in-flight step restores stable', () => {
    const raw = JSON.stringify({
      items: [
        {
          id: 'item-1',
          seq: 1,
          name: 'Iron Sword',
          brief: 'Iron Sword',
          stage: 'judging',
          requestedType: 'auto',
          run: runWithVariants,
        },
      ],
      selectedId: 'item-1',
      nextSeq: 2,
    });
    expect(deserializeQueue(raw).items[0]!.stage).toBe('postprocessed');
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
    expect(stageActiveStep('checked-in')).toBe(6);
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
    expect(primaryActionLabel('checked-in')).toBe('Tag (generate metadata)');
    expect(primaryActionLabel('synthesizing')).toBeNull();
    expect(primaryActionLabel('generating')).toBeNull();
    expect(primaryActionLabel('variants')).toBeNull();
    expect(primaryActionLabel('done')).toBeNull();
  });
});

describe('approvedItemPatch', () => {
  it('advances a fresh approval to the approved stage with a score summary', () => {
    const patch = approvedItemPatch({
      briefId: 'green-slime-baby',
      variantIndex: 2,
      assetPath: 'generated/green-slime-baby-var-2.png',
      sensorScore: '6/7',
      judgeScore: '4',
    });
    expect(patch.stage).toBe('approved');
    expect(patch.approvedAssetPath).toBe('generated/green-slime-baby-var-2.png');
    expect(patch.generationRequestedAt).toBeNull();
    expect(patch.lastError).toBeNull();
    expect(patch.checkinBranch).toBeNull();
    expect(patch.checkinIssueUrl).toBeNull();
    expect(patch.checkinIssueTitle).toBeNull();
    expect(patch.checkinIssueBody).toBeNull();
    expect(patch.checkinSummary).toBeNull();
    expect(patch.approvalSummary).toBe(
      'Approved green-slime-baby variant 2 -> generated/green-slime-baby-var-2.png ' +
        '(6/7, judge 4). Now Tag to add catalog metadata.',
    );
  });

  it('omits the judge segment when there is no judge score', () => {
    const patch = approvedItemPatch({
      briefId: 'bent-pipe',
      variantIndex: 0,
      assetPath: 'generated/bent-pipe-var-0.png',
      sensorScore: '7/7',
      judgeScore: null,
    });
    expect(patch.approvalSummary).toBe(
      'Approved bent-pipe variant 0 -> generated/bent-pipe-var-0.png (7/7). ' +
        'Now Tag to add catalog metadata.',
    );
  });

  it('notes a judge override in the summary', () => {
    const patch = approvedItemPatch({
      briefId: 'slime-king',
      variantIndex: 4,
      assetPath: 'generated/slime-king-var-4.png',
      sensorScore: '5/7',
      judgeScore: '2',
      judgeOverride: true,
    });
    expect(patch.approvalSummary).toContain('(judge override)');
  });

  it('still advances to approved on the already-approved (409) path so Tag unlocks', () => {
    // Regression: re-approving an already-approved variant must NOT dead-end on
    // the Approve step — the asset is in the catalog, so it has to reach `approved`.
    const patch = approvedItemPatch({
      briefId: 'green-slime-baby',
      variantIndex: 2,
      assetPath: 'generated/green-slime-baby-var-2.png',
      alreadyApproved: true,
    });
    expect(patch.stage).toBe('approved');
    expect(patch.approvedAssetPath).toBe('generated/green-slime-baby-var-2.png');
    expect(patch.lastError).toBeNull();
    expect(patch.approvalSummary).toContain('already approved with identical content');
    expect(patch.approvalSummary).toContain('Tag to add catalog metadata');
  });

  it('appends a durable-queue-failure warning (with reason) when the push failed', () => {
    // PR1: the catalog write succeeded but the durable assets/queue push did not.
    // The warning must be baked into approvalSummary (not just a transient status)
    // so recompute's re-render keeps it and the operator does not discard the
    // worktree with an un-persisted approval.
    const patch = approvedItemPatch({
      briefId: 'green-slime-baby',
      variantIndex: 2,
      assetPath: 'generated/green-slime-baby-var-2.png',
      sensorScore: '6/7',
      judgeScore: '4',
      queueCommitFailed: true,
      queueCommitError: 'push rejected',
    });
    expect(patch.stage).toBe('approved');
    // The base approval summary is preserved…
    expect(patch.approvalSummary).toContain(
      'Approved green-slime-baby variant 2 -> generated/green-slime-baby-var-2.png',
    );
    // …and the durability warning + reason are appended.
    expect(patch.approvalSummary).toContain('Durable queue push FAILED');
    expect(patch.approvalSummary).toContain('(push rejected).');
  });

  it('omits the reason parenthetical when a failed push has no error string', () => {
    const patch = approvedItemPatch({
      briefId: 'bent-pipe',
      variantIndex: 0,
      assetPath: 'generated/bent-pipe-var-0.png',
      sensorScore: '7/7',
      judgeScore: null,
      queueCommitFailed: true,
    });
    expect(patch.approvalSummary).toContain('Durable queue push FAILED');
    expect(patch.approvalSummary.endsWith('safe across sessions.')).toBe(true);
  });

  it('leaves the summary unchanged on a successful (non-failed) queue push', () => {
    const patch = approvedItemPatch({
      briefId: 'bent-pipe',
      variantIndex: 0,
      assetPath: 'generated/bent-pipe-var-0.png',
      sensorScore: '7/7',
      judgeScore: null,
      queueCommitFailed: false,
    });
    expect(patch.approvalSummary).not.toContain('Durable queue push FAILED');
    expect(patch.approvalSummary).toBe(
      'Approved bent-pipe variant 0 -> generated/bent-pipe-var-0.png (7/7). ' +
        'Now Tag to add catalog metadata.',
    );
  });

  it('drives queueDurability from the push outcome (failed -> "failed")', () => {
    // #7: queueDurability is the single source of truth the render path reads to
    // color the approved summary. A failed durable push must set it to 'failed' so
    // the status stays red instead of being erased by a later green re-render.
    const patch = approvedItemPatch({
      briefId: 'bent-pipe',
      variantIndex: 0,
      assetPath: 'generated/bent-pipe-var-0.png',
      sensorScore: '7/7',
      judgeScore: null,
      queueCommitFailed: true,
    });
    expect(patch.queueDurability).toBe('failed');
  });

  it('sets queueDurability to "ok" on a successful or no-op push', () => {
    expect(
      approvedItemPatch({
        briefId: 'bent-pipe',
        variantIndex: 0,
        assetPath: 'generated/bent-pipe-var-0.png',
        sensorScore: '7/7',
        judgeScore: null,
        queueCommitFailed: false,
      }).queueDurability,
    ).toBe('ok');
  });

  it('sets queueDurability to null when no queue-commit was attempted (old sidecar)', () => {
    // An absent queueCommitFailed (undefined) means the sidecar did not attempt a
    // queue-commit (pre-queue-commit sidecar, or the already-approved path on an
    // old server). This is NOT the same as success — do not fabricate 'ok'.
    expect(
      approvedItemPatch({
        briefId: 'bent-pipe',
        variantIndex: 0,
        assetPath: 'generated/bent-pipe-var-0.png',
        alreadyApproved: true,
      }).queueDurability,
    ).toBeNull();
  });

  it('produces a patch that drives an item from variants to approved via updateItem', () => {
    let state = createEmptyQueue();
    state = addItem(state, 'Green Slime Baby');
    const item = state.items[0]!;
    state = updateItem(state, item.id, { stage: 'variants' });
    expect(stageActiveStep(getItem(state, item.id)!.stage)).toBe(5);

    const patch = approvedItemPatch({
      briefId: 'green-slime-baby',
      variantIndex: 2,
      assetPath: 'generated/green-slime-baby-var-2.png',
      alreadyApproved: true,
    });
    state = updateItem(state, item.id, patch);

    const updated = getItem(state, item.id)!;
    expect(updated.stage).toBe('approved');
    // Approved is step 6 — i.e. the Tag step is now the active/next action.
    expect(stageActiveStep(updated.stage)).toBe(6);
    expect(primaryActionLabel(updated.stage)).toBe('Tag (generate metadata)');
  });
});

describe('metadataDonePatch (Tag-step durability, #1c/#7)', () => {
  const base = {
    provider: 'heuristic',
    processedCount: 1,
    changedCount: 1,
    rejectedCount: 0,
  } as const;

  it('marks the tag durable when the re-queue committed or was a no-op', () => {
    expect(
      metadataDonePatch({ ...base, queueStatus: 'committed', previousDurability: null }),
    ).toMatchObject({ stage: 'done', queueDurability: 'ok', approvalSummary: null });
    expect(
      metadataDonePatch({ ...base, queueStatus: 'noop', previousDurability: 'failed' })
        .queueDurability,
    ).toBe('ok');
  });

  it('marks the tag failed and bakes the reason into metadataSummary on a failed push', () => {
    const patch = metadataDonePatch({
      ...base,
      queueStatus: 'failed',
      queueCommitError: 'push rejected',
      previousDurability: 'ok',
    });
    expect(patch.queueDurability).toBe('failed');
    expect(patch.metadataSummary).toContain('Durable queue push FAILED');
    expect(patch.metadataSummary).toContain('(push rejected)');
    expect(patch.metadataSummary).toContain('Tagged via heuristic: processed=1, changed=1');
  });

  it('PRESERVES prior durability when nothing was re-queued (null) — no fabricated green', () => {
    // The core #1c/#7 regression: a no-op re-queue (queueCommit:null) used to be
    // treated as success and flip the item to green 'ok', erasing a real prior
    // 'failed'. It must instead leave the earlier durability verdict untouched.
    expect(
      metadataDonePatch({
        ...base,
        changedCount: 0,
        queueStatus: null,
        previousDurability: 'failed',
      }).queueDurability,
    ).toBe('failed');
    expect(
      metadataDonePatch({ ...base, changedCount: 0, queueStatus: null, previousDurability: 'ok' })
        .queueDurability,
    ).toBe('ok');
    expect(
      metadataDonePatch({ ...base, changedCount: 0, queueStatus: null, previousDurability: null })
        .queueDurability,
    ).toBeNull();
  });

  it('PRESERVES prior durability on a ci-refused (skipped) push and adds no warning', () => {
    const patch = metadataDonePatch({
      ...base,
      queueStatus: 'skipped',
      previousDurability: 'failed',
    });
    expect(patch.queueDurability).toBe('failed');
    expect(patch.metadataSummary).not.toContain('Durable queue push FAILED');
  });
});

describe('metadataReadyBanner (Tag→Done banner honesty, #1c/#7)', () => {
  const base = {
    provider: 'heuristic',
    processedCount: 1,
    changedCount: 1,
    rejectedCount: 0,
  } as const;

  it('shows the green "ready to use" banner only when the tag is durable (ok)', () => {
    const patch = metadataDonePatch({
      ...base,
      queueStatus: 'committed',
      previousDurability: null,
    });
    const banner = metadataReadyBanner(patch);
    expect(banner.color).toBe(METADATA_BANNER_OK_COLOR);
    expect(banner.message).toContain('ready to use');
    expect(banner.message.startsWith(patch.metadataSummary)).toBe(true);
  });

  it('shows a RED banner with NO "ready to use" on an outright failed push', () => {
    const patch = metadataDonePatch({
      ...base,
      queueStatus: 'failed',
      queueCommitError: 'push rejected',
      previousDurability: 'ok',
    });
    const banner = metadataReadyBanner(patch);
    expect(banner.color).toBe(METADATA_BANNER_FAILED_COLOR);
    expect(banner.message).not.toContain('ready to use');
    expect(banner.message).toContain('Durable queue push FAILED');
  });

  it('stays RED when a null/skipped re-queue INHERITS a prior failed (the caller regression)', () => {
    // The exact bug Round-2 caught: the banner used to gate on this Tag's OWN
    // push status, so a no-op (null) or ci-refused (skipped) re-queue that
    // inherits an earlier 'failed' would flash green "ready to use" before
    // recompute restored red. Gating on the honest patch.queueDurability (which
    // metadataDonePatch preserves as 'failed' here) keeps it red. This locks the
    // presentation so re-introducing raw-status gating in the DOM caller fails.
    for (const queueStatus of ['skipped', null] as const) {
      const patch = metadataDonePatch({
        ...base,
        changedCount: 0,
        queueStatus,
        previousDurability: 'failed',
      });
      expect(patch.queueDurability).toBe('failed');
      const banner = metadataReadyBanner(patch);
      expect(banner.color).toBe(METADATA_BANNER_FAILED_COLOR);
      expect(banner.message).not.toContain('ready to use');
    }
  });

  it('shows a NEUTRAL banner (not green) when durability is unknown (null)', () => {
    // A null/skipped re-queue with null prior durability means no evidence of
    // durability was ever established. The banner must NOT say "ready to use".
    for (const queueStatus of ['skipped', null] as const) {
      const patch = metadataDonePatch({
        ...base,
        changedCount: 0,
        queueStatus,
        previousDurability: null,
      });
      expect(patch.queueDurability).toBeNull();
      const banner = metadataReadyBanner(patch);
      expect(banner.color).not.toBe(METADATA_BANNER_OK_COLOR);
      expect(banner.color).not.toBe(METADATA_BANNER_FAILED_COLOR);
      expect(banner.message).not.toContain('ready to use');
    }
  });
});

describe('applyMetadataTagResult (bundled Tag→Done transition, #1c/#7 caller lock)', () => {
  const base = {
    provider: 'heuristic',
    processedCount: 1,
    changedCount: 1,
    rejectedCount: 0,
  } as const;

  it('pairs a durable patch with a green banner on a committed push', () => {
    const { patch, banner } = applyMetadataTagResult({
      ...base,
      queueStatus: 'committed',
      previousDurability: null,
    });
    expect(patch.queueDurability).toBe('ok');
    expect(banner.color).toBe(METADATA_BANNER_OK_COLOR);
    expect(banner.message).toContain('ready to use');
  });

  it('pairs a failed patch with a red banner (no "ready to use") on a failed push', () => {
    const { patch, banner } = applyMetadataTagResult({
      ...base,
      queueStatus: 'failed',
      queueCommitError: 'push rejected',
      previousDurability: 'ok',
    });
    expect(patch.queueDurability).toBe('failed');
    expect(banner.color).toBe(METADATA_BANNER_FAILED_COLOR);
    expect(banner.message).not.toContain('ready to use');
  });

  it('keeps a null/skipped re-queue RED when it inherits a prior failed (caller regression lock)', () => {
    // Locks the WHOLE transition the DOM caller applies verbatim: a no-op (null)
    // or ci-refused (skipped) re-queue that inherits an earlier 'failed' must
    // yield a red banner with no "ready to use". Because the caller destructures
    // { patch, banner } from THIS function and passes banner straight to
    // setWorkflowStatus, re-gating the banner on the raw push status can no longer
    // slip in without abandoning this tested function.
    for (const queueStatus of ['skipped', null] as const) {
      const { patch, banner } = applyMetadataTagResult({
        ...base,
        changedCount: 0,
        queueStatus,
        previousDurability: 'failed',
      });
      expect(patch.queueDurability).toBe('failed');
      expect(banner.color).toBe(METADATA_BANNER_FAILED_COLOR);
      expect(banner.message).not.toContain('ready to use');
    }
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a populated queue', () => {
    let state = addItem(createEmptyQueue(), 'Purple Potion Bottle', '', 'item');
    state = updateItem(state, 'item-1', {
      stage: 'variants',
      resolvedType: 'item',
      candidates: [{ id: 'purple-potion-bottle', yamlPath: 'a.yaml', description: 'd', yaml: 'y' }],
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

  it('round-trips queueDurability and defaults unknown/absent values to null', () => {
    // #7 durability field: a 'failed' state must survive serialize→deserialize so the
    // warning persists across a page reload; pre-PR1 stored items (no field) and any
    // malformed value must sanitize to null rather than throwing or leaking a string.
    let state = addItem(createEmptyQueue(), 'Durable Sprite', '', 'item');
    state = updateItem(state, 'item-1', { stage: 'approved', queueDurability: 'failed' });
    expect(deserializeQueue(serializeQueue(state)).items[0]?.queueDurability).toBe('failed');

    const legacy = JSON.stringify({
      items: [{ id: 'item-1', seq: 1, brief: 'Legacy', stage: 'approved' }],
      selectedId: 'item-1',
      nextSeq: 2,
    });
    expect(deserializeQueue(legacy).items[0]?.queueDurability).toBeNull();

    const malformed = JSON.stringify({
      items: [{ id: 'item-1', seq: 1, brief: 'Bad', stage: 'approved', queueDurability: 'yes' }],
      selectedId: 'item-1',
      nextSeq: 2,
    });
    expect(deserializeQueue(malformed).items[0]?.queueDurability).toBeNull();
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

describe('deserialize name/brief back-compat', () => {
  it('derives name from the brief for items persisted before the split', () => {
    const raw = JSON.stringify({
      items: [
        {
          id: 'item-1',
          seq: 1,
          brief: 'Purple Potion Bottle',
          kebabName: 'purple-potion-bottle',
          stage: 'draft',
        },
      ],
      selectedId: 'item-1',
      nextSeq: 2,
    });
    const restored = deserializeQueue(raw);
    const item = restored.items[0]!;
    expect(item.name).toBe('Purple Potion Bottle');
    expect(item.brief).toBe('Purple Potion Bottle');
    // Identity slug is preserved verbatim — no migration.
    expect(item.kebabName).toBe('purple-potion-bottle');
  });

  it('keeps a stored name distinct from the brief', () => {
    const raw = JSON.stringify({
      items: [
        {
          id: 'item-1',
          seq: 1,
          name: 'Skull Mace',
          brief: 'heavy two-handed, glowing green eye sockets',
          kebabName: 'skull-mace',
          stage: 'draft',
        },
      ],
      selectedId: 'item-1',
      nextSeq: 2,
    });
    const item = deserializeQueue(raw).items[0]!;
    expect(item.name).toBe('Skull Mace');
    expect(item.brief).toBe('heavy two-handed, glowing green eye sockets');
    expect(item.kebabName).toBe('skull-mace');
  });
});

describe('restartToBriefPatch', () => {
  const run: QueueRun = { briefId: 'skull-mace', runId: 'run-1', candidates: [] };

  it('rewinds to draft and clears every post-synthesis artifact', () => {
    let state = addItem(createEmptyQueue(), 'Skull Mace', 'glowing eyes');
    state = updateItem(state, 'item-1', {
      stage: 'approved',
      resolvedType: 'item',
      candidates: [{ id: 'skull-mace-v1', yamlPath: 'a.yaml', description: 'd', yaml: 'y' }],
      chosenCandidatePath: 'a.yaml',
      briefPath: 'briefs/skull-mace.yaml',
      run,
      approvedAssetPath: 'public/assets/generated/skull-mace.png',
      checkinIssueUrl: 'https://github.com/nalfeo/Crawler/issues/99',
      checkinIssueTitle: 'Asset check-in: skull-mace',
      checkinIssueBody: '## Asset check-in\n...',
      checkinBranch: 'assets/checkin-abc123',
      checkinSummary: 'Checked in public/assets/generated/skull-mace.png',
    });
    const patch = restartToBriefPatch(getItem(state, 'item-1')!);
    expect(patch.stage).toBe('draft');
    expect(patch.run).toBeNull();
    expect(patch.candidates).toEqual([]);
    expect(patch.chosenCandidatePath).toBeNull();
    expect(patch.briefPath).toBeNull();
    expect(patch.approvedAssetPath).toBeNull();
    expect(patch.checkinIssueUrl).toBeNull();
    expect(patch.checkinIssueTitle).toBeNull();
    expect(patch.checkinIssueBody).toBeNull();
    expect(patch.checkinBranch).toBeNull();
    expect(patch.checkinSummary).toBeNull();
    // Operator identity/direction is intentionally NOT touched.
    expect('name' in patch).toBe(false);
    expect('brief' in patch).toBe(false);
    expect('requestedType' in patch).toBe(false);
  });

  it('resets resolvedType to null for auto items but keeps an explicit type', () => {
    const autoItem = addItem(createEmptyQueue(), 'Skull Mace').items[0]!;
    expect(restartToBriefPatch(autoItem).resolvedType).toBeNull();
    const typedItem = addItem(createEmptyQueue(), 'Skull Mace', '', 'item').items[0]!;
    expect(restartToBriefPatch(typedItem).resolvedType).toBe('item');
  });
});

describe('restartToSheetPatch', () => {
  const run: QueueRun = { briefId: 'skull-mace', runId: 'run-1', candidates: [] };

  it('keeps the generated sheet and lands on the sheet step', () => {
    let state = addItem(createEmptyQueue(), 'Skull Mace');
    state = updateItem(state, 'item-1', {
      stage: 'approved',
      run,
      approvedAssetPath: 'public/assets/generated/skull-mace.png',
      checkinIssueUrl: 'https://github.com/nalfeo/Crawler/issues/99',
      checkinIssueTitle: 'Asset check-in: skull-mace',
      checkinIssueBody: '## Asset check-in\n...',
      checkinBranch: 'assets/checkin-abc123',
      checkinSummary: 'Checked in public/assets/generated/skull-mace.png',
      metadataSummary: 'tagged',
    });
    const patch = restartToSheetPatch(getItem(state, 'item-1')!);
    expect(patch.stage).toBe('sheet');
    // The expensive AI sheet is preserved (not part of the patch).
    expect('run' in patch).toBe(false);
    expect(patch.approvedAssetPath).toBeNull();
    expect(patch.checkinIssueUrl).toBeNull();
    expect(patch.checkinIssueTitle).toBeNull();
    expect(patch.checkinIssueBody).toBeNull();
    expect(patch.checkinBranch).toBeNull();
    expect(patch.checkinSummary).toBeNull();
    expect(patch.metadataSummary).toBeNull();
  });

  it('falls back to candidates when no sheet exists but a brief/choice does', () => {
    let state = addItem(createEmptyQueue(), 'Skull Mace');
    state = updateItem(state, 'item-1', { stage: 'sheet', briefPath: 'briefs/skull-mace.yaml' });
    expect(restartToSheetPatch(getItem(state, 'item-1')!).stage).toBe('candidates');
  });

  it('falls back to draft when neither a sheet nor a brief/choice exists', () => {
    const item = addItem(createEmptyQueue(), 'Skull Mace').items[0]!;
    expect(restartToSheetPatch(item).stage).toBe('draft');
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

describe('candidateStatus', () => {
  function input(
    passed: boolean,
    combinedPassed: boolean,
    judge: { passed: boolean } | null,
  ): CandidateStatusInput {
    return { passed, combinedPassed, judge };
  }

  it('labels a combined pass as PASS even if the sensor list is empty', () => {
    expect(candidateStatus(input(true, true, { passed: true }))).toEqual({
      kind: 'pass',
      label: 'PASS',
    });
  });

  it('labels a sensor-gate failure as sensor fail', () => {
    expect(candidateStatus(input(false, false, null))).toEqual({
      kind: 'sensor-failed',
      label: 'sensor fail',
    });
  });

  it('labels a sensors-pass / judge-reject as judge fail', () => {
    expect(candidateStatus(input(true, false, { passed: false }))).toEqual({
      kind: 'judge-rejected',
      label: 'judge fail',
    });
  });

  it('does NOT mislabel a sensors-pass-but-unjudged variant as a sensor failure', () => {
    // Regression: an over-cap / not-yet-judged variant has passed sensors but no
    // judge verdict, so combinedPassed is false. It must read as neutral
    // "not judged", never red "sensor fail".
    expect(candidateStatus(input(true, false, null))).toEqual({
      kind: 'unjudged',
      label: 'not judged',
    });
  });

  it('treats a sensor failure as sensor fail even when a (stale) judge verdict exists', () => {
    expect(candidateStatus(input(false, false, { passed: true })).kind).toBe('sensor-failed');
  });
});

describe('describeJudgeSkipReason', () => {
  it('returns null once the candidate has been judged', () => {
    expect(describeJudgeSkipReason('sensor-failed', true)).toBeNull();
    expect(describeJudgeSkipReason(null, true)).toBeNull();
  });

  it('explains legacy sensor-gated judging', () => {
    expect(describeJudgeSkipReason('sensor-failed', false)).toContain('legacy');
  });

  it('explains the per-run cap and how to raise it', () => {
    expect(describeJudgeSkipReason('over-cap', false)).toContain('judge.maxVariants');
  });

  it('explains an exhausted budget', () => {
    expect(describeJudgeSkipReason('over-budget', false)).toContain('budget');
  });

  it('explains a disabled judge', () => {
    expect(describeJudgeSkipReason('judge-disabled', false)).toContain('disabled');
  });

  it('falls back to a generic prompt for an unknown or absent reason', () => {
    expect(describeJudgeSkipReason(null, false)).toContain('run Judge');
    expect(describeJudgeSkipReason('something-new', false)).toContain('run Judge');
  });
});
