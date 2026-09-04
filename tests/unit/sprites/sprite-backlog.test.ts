import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ManifestEntry } from '../../../src/shared/generated-assets.js';
import {
  buildSpriteBacklogPlan,
  collectBacklogBriefs,
  prepareSpriteBacklog,
  recordSpriteBacklogResult,
  type SpriteBacklogBrief,
  type PreparedSpriteBacklog,
} from '../../../scripts/sprites/sprite-backlog.js';
import { resolvePendingAnnotationsPath } from '../../../.github/extensions/sprite-editor/lib/pending-annotation-overlay.mjs';

function manifestEntry(briefId: string): ManifestEntry {
  return {
    briefId,
    spriteName: `${briefId}-var-0`,
    assetPath: `generated/${briefId}-var-0.png`,
    approvedAt: '2026-09-01T00:00:00.000Z',
    sourceRun: 'run-1',
    variantIndex: 0,
    anchor: null,
    sensorScore: 'pass',
    judgeScore: null,
  };
}

function brief(name: string, floor: number, judgeEnabled = true): SpriteBacklogBrief {
  return {
    concept: name.replace(/-v\d+$/, ''),
    name,
    path: `C:\\repo\\briefs\\${name}.yaml`,
    floor,
    judgeEnabled,
  };
}

describe('buildSpriteBacklogPlan', () => {
  it('prioritizes unique current dislikes before missing art and orders each group by floor', () => {
    const entries = {
      'floor-two-var-0': manifestEntry('floor-two'),
      'floor-one-var-0': manifestEntry('floor-one'),
      'stale-var-0': manifestEntry('stale'),
    };
    const plan = buildSpriteBacklogPlan({
      briefs: [
        brief('floor-one', 1),
        brief('floor-two', 2),
        brief('missing-one', 1),
        brief('missing-three', 3),
      ],
      manifestEntries: entries,
      dislikedSpriteNames: new Set([
        'floor-two-var-0',
        'floor-two-var-0',
        'floor-one-var-0',
        'not-in-manifest-var-0',
      ]),
      placeholderReport: {
        placeholderOnly: [
          { concept: 'missing-three', placeholders: [], realAssets: [] },
          { concept: 'missing-one', placeholders: [], realAssets: [] },
        ],
      },
      floors: new Set([1, 2, 3]),
      limit: 5,
    });

    expect(plan.selected.map(({ source, concept }) => `${source}:${concept}`)).toEqual([
      'disliked:floor-one',
      'disliked:floor-two',
      'missing:missing-one',
      'missing:missing-three',
    ]);
  });

  it('skips completed concepts, unjudged briefs, and floors outside the requested set', () => {
    const plan = buildSpriteBacklogPlan({
      briefs: [
        brief('done', 1),
        brief('unjudged', 1, false),
        brief('floor-four', 4),
        brief('ready', 2),
      ],
      manifestEntries: {
        'done-var-0': manifestEntry('done'),
        'unjudged-var-0': manifestEntry('unjudged'),
        'floor-four-var-0': manifestEntry('floor-four'),
        'ready-var-0': manifestEntry('ready'),
      },
      dislikedSpriteNames: new Set([
        'done-var-0',
        'unjudged-var-0',
        'floor-four-var-0',
        'ready-var-0',
      ]),
      placeholderReport: { placeholderOnly: [] },
      pendingReviewConcepts: new Set(['done']),
      floors: new Set([1, 2, 3]),
      limit: 5,
    });

    expect(plan.selected.map((item) => item.concept)).toEqual(['ready']);
    expect(plan.blockedDisliked).toEqual(['floor-four', 'unjudged']);
  });

  it('prefers a canonical bare brief over a versioned brief for the same concept', () => {
    const plan = buildSpriteBacklogPlan({
      briefs: [brief('sprite-v2', 1), brief('sprite', 1)],
      manifestEntries: { 'sprite-var-0': manifestEntry('sprite') },
      dislikedSpriteNames: new Set(['sprite-var-0']),
      placeholderReport: { placeholderOnly: [] },
      floors: new Set([1]),
      limit: 1,
    });

    expect(plan.selected[0]?.name).toBe('sprite');
  });

  it('enforces a positive integer limit', () => {
    expect(() =>
      buildSpriteBacklogPlan({
        briefs: [],
        manifestEntries: {},
        dislikedSpriteNames: new Set(),
        placeholderReport: { placeholderOnly: [] },
        floors: new Set([1]),
        limit: 0,
      }),
    ).toThrow('positive integer');
  });

  it('selects explicit retries ahead of the ordinary limited backlog', () => {
    const plan = buildSpriteBacklogPlan({
      briefs: [brief('first', 1), brief('retry-me', 3)],
      manifestEntries: { 'first-var-0': manifestEntry('first') },
      dislikedSpriteNames: new Set(['first-var-0']),
      placeholderReport: { placeholderOnly: [] },
      retrySources: new Map([['retry-me', 'disliked']]),
      floors: new Set([1, 2, 3]),
      limit: 1,
    });

    expect(plan.selected.map((item) => item.concept)).toEqual(['retry-me']);
  });

  it('rejects retries without an eligible brief', () => {
    expect(() =>
      buildSpriteBacklogPlan({
        briefs: [brief('outside-floor', 2)],
        manifestEntries: {},
        dislikedSpriteNames: new Set(),
        placeholderReport: { placeholderOnly: [] },
        retrySources: new Map([['outside-floor', 'disliked']]),
        floors: new Set([1]),
        limit: 1,
      }),
    ).toThrow('no eligible judged brief');
  });

  it('persists a passing result immediately as pending human review', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sprite-backlog-state-'));
    try {
      const statePath = path.join(root, 'state.json');
      const selected = { ...brief('ready', 1), source: 'disliked' as const };
      const prepared: PreparedSpriteBacklog = {
        statePath,
        state: { version: 1, pendingReview: {} },
        plan: {
          selected: [selected],
          available: [selected],
          blockedDisliked: [],
          blockedMissing: [],
          pendingReviewConcepts: [],
          invalidBriefs: [],
        },
      };
      recordSpriteBacklogResult(
        prepared,
        {
          briefPath: selected.path,
          status: 'succeeded',
          runDir: 'C:\\runs\\ready',
          summary: {
            candidates: [{ combinedPassed: true }],
          },
        },
        new Date('2026-09-04T20:00:00.000Z'),
      );

      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        pendingReview: Record<string, { runDir: string; generatedAt: string }>;
      };
      expect(state.pendingReview.ready).toEqual({
        source: 'disliked',
        briefPath: selected.path,
        runDir: 'C:\\runs\\ready',
        generatedAt: '2026-09-04T20:00:00.000Z',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not create pending-review state when no candidate passes the combined gate', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sprite-backlog-state-'));
    try {
      const statePath = path.join(root, 'state.json');
      const selected = { ...brief('retry-me', 1), source: 'disliked' as const };
      const prepared: PreparedSpriteBacklog = {
        statePath,
        state: { version: 1, pendingReview: {} },
        plan: {
          selected: [selected],
          available: [selected],
          blockedDisliked: [],
          blockedMissing: [],
          pendingReviewConcepts: [],
          invalidBriefs: [],
        },
      };
      recordSpriteBacklogResult(prepared, {
        briefPath: selected.path,
        status: 'succeeded',
        runDir: 'C:\\runs\\retry-me',
        summary: { candidates: [{ combinedPassed: false }] },
      });

      expect(() => readFileSync(statePath, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('collectBacklogBriefs', () => {
  it('continues past invalid briefs and excludes draft directories', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sprite-backlog-briefs-'));
    try {
      mkdirSync(path.join(root, 'briefs', 'items', 'draft'), { recursive: true });
      mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
      mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
      cpSync(
        path.join(process.cwd(), 'data', 'sprite-types', 'item.json'),
        path.join(root, 'data', 'sprite-types', 'item.json'),
      );
      cpSync(
        path.join(process.cwd(), 'data', 'palettes', 'kenney-roguelike.json'),
        path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      );
      writeFileSync(
        path.join(root, 'briefs', 'items', 'valid.yaml'),
        'type: item\nname: valid\ndescription: A valid item.\n',
      );
      writeFileSync(
        path.join(root, 'briefs', 'items', 'invalid.yaml'),
        'type: item\nname: invalid\ndescription: An invalid item.\nvariations:\n  - bad: object\n',
      );
      writeFileSync(
        path.join(root, 'briefs', 'items', 'draft', 'ignored.yaml'),
        'not: a valid brief\n',
      );

      const discovered = collectBacklogBriefs(root);

      expect(discovered.briefs.map((item) => item.name)).toEqual(['valid']);
      expect(discovered.invalidBriefs).toHaveLength(1);
      expect(discovered.invalidBriefs[0]?.path).toContain('invalid.yaml');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('prepareSpriteBacklog retry state', () => {
  it('removes pending review for a retry and preserves dry-run state on disk', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sprite-backlog-retry-'));
    try {
      mkdirSync(path.join(root, 'briefs', 'items'), { recursive: true });
      mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
      mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
      cpSync(
        path.join(process.cwd(), 'data', 'sprite-types', 'item.json'),
        path.join(root, 'data', 'sprite-types', 'item.json'),
      );
      cpSync(
        path.join(process.cwd(), 'data', 'palettes', 'kenney-roguelike.json'),
        path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      );
      writeFileSync(
        path.join(root, 'briefs', 'items', 'retry-me.yaml'),
        'type: item\nname: retry-me\ndescription: A valid retry item.\n',
      );
      const statePath = path.join(root, 'state.json');
      const originalState = {
        version: 1,
        pendingReview: {
          'retry-me': {
            source: 'disliked',
            briefPath: 'briefs/items/retry-me.yaml',
            runDir: 'generated/runs/retry-me/old',
            generatedAt: '2026-09-04T20:00:00.000Z',
          },
        },
      };
      writeFileSync(statePath, `${JSON.stringify(originalState)}\n`);

      const dryRun = prepareSpriteBacklog(root, {
        floors: [1],
        limit: 5,
        statePath,
        retryConcepts: ['retry-me-var-3'],
        persistRetryChanges: false,
      });
      expect(dryRun.state.pendingReview).toEqual({});
      expect(dryRun.plan.selected.map((item) => item.concept)).toEqual(['retry-me']);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(originalState);

      const persisted = prepareSpriteBacklog(root, {
        floors: [1],
        limit: 5,
        statePath,
        retryConcepts: ['retry-me'],
      });
      expect(persisted.state.pendingReview).toEqual({});
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
        version: 1,
        pendingReview: {},
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prioritizes a queued pending-overlay dislike', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sprite-backlog-pending-dislike-'));
    const pendingPath = resolvePendingAnnotationsPath(root);
    try {
      mkdirSync(path.join(root, 'briefs', 'items'), { recursive: true });
      mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
      mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
      mkdirSync(path.join(root, 'public', 'assets', 'generated', 'entries'), { recursive: true });
      mkdirSync(path.dirname(pendingPath), { recursive: true });
      cpSync(
        path.join(process.cwd(), 'data', 'sprite-types', 'item.json'),
        path.join(root, 'data', 'sprite-types', 'item.json'),
      );
      cpSync(
        path.join(process.cwd(), 'data', 'palettes', 'kenney-roguelike.json'),
        path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      );
      writeFileSync(
        path.join(root, 'briefs', 'items', 'queued-dislike.yaml'),
        'type: item\nname: queued-dislike\ndescription: A queued dislike.\n',
      );
      writeFileSync(
        path.join(root, 'public', 'assets', 'generated', 'entries', 'queued-dislike-var-0.json'),
        `${JSON.stringify(manifestEntry('queued-dislike'))}\n`,
      );
      writeFileSync(
        pendingPath,
        JSON.stringify({
          sprites: {
            'queued-dislike-var-0': { base: null, annotation: { disliked: true } },
          },
        }),
      );

      const prepared = prepareSpriteBacklog(root, { floors: [1], limit: 1 });

      expect(prepared.plan.selected.map(({ source, concept }) => `${source}:${concept}`)).toEqual([
        'disliked:queued-dislike',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(pendingPath, { force: true });
    }
  });
});
