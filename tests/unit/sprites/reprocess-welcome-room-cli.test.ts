import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildReprocessTargets,
  collectWelcomeRoomSpriteIds,
  parseRunRefFromSourceRun,
} from '../../../scripts/sprites/reprocess-welcome-room-cli.js';

describe('reprocess-welcome-room-cli helpers', () => {
  it('collects only welcome-room prefixed catalog sprites from the welcome-room set piece', () => {
    const spriteIds = collectWelcomeRoomSpriteIds({
      setPieces: [
        {
          id: 'welcome-room',
          props: [
            {
              layers: [
                { sprite: { source: 'catalog', spriteId: 'welcome-room-rug-var-0' } },
                { sprite: { source: 'catalog', spriteId: 'prop-wall-sconce-var-1' } },
                { sprite: { source: 'sheet', spriteId: 'welcome-room-desk-var-0' } },
              ],
            },
            {
              layers: [
                { sprite: { source: 'catalog', spriteId: 'welcome-room-desk-var-0' } },
                { sprite: { source: 'catalog', spriteId: 'welcome-room-rug-var-0' } },
              ],
            },
          ],
        },
      ],
    });
    expect(spriteIds).toEqual(['welcome-room-desk-var-0', 'welcome-room-rug-var-0']);
  });

  it('parses brief/run from sourceRun paths with forward or back slashes', () => {
    expect(
      parseRunRefFromSourceRun('generated/runs/welcome-room-rug/2026-07-08T03-53-58-1d62f27a'),
    ).toEqual({
      briefId: 'welcome-room-rug',
      runId: '2026-07-08T03-53-58-1d62f27a',
    });

    expect(
      parseRunRefFromSourceRun(
        'C:\\repo\\generated\\runs\\welcome-room-desk\\2026-07-08T04-10-13-f8ac9632',
      ),
    ).toEqual({
      briefId: 'welcome-room-desk',
      runId: '2026-07-08T04-10-13-f8ac9632',
    });
  });

  it('builds target entries from manifest metadata', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'crawler-reprocess-welcome-room-'));
    try {
      const runDir = path.join(
        repoRoot,
        'generated',
        'runs',
        'welcome-room-shop-table',
        '2026-07-08T04-00-23-d83d5284',
      );
      mkdirSync(runDir, { recursive: true });
      writeFileSync(path.join(runDir, 'summary.json'), '{}');

      const targets = buildReprocessTargets(
        ['welcome-room-shop-table-var-0'],
        {
          entries: {
            'welcome-room-shop-table-var-0': {
              spriteName: 'welcome-room-shop-table-var-0',
              sourceRun: 'generated/runs/welcome-room-shop-table/2026-07-08T04-00-23-d83d5284',
              variantIndex: 0,
              judgeScore: '4',
            },
          },
        },
        repoRoot,
      );

      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        spriteId: 'welcome-room-shop-table-var-0',
        variantIndex: 0,
        sourceRun: 'generated/runs/welcome-room-shop-table/2026-07-08T04-00-23-d83d5284',
        runRef: {
          briefId: 'welcome-room-shop-table',
          runId: '2026-07-08T04-00-23-d83d5284',
        },
        beforeJudgeScore: '4',
      });
      expect(targets[0]?.runDir).toBe(runDir);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
