import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materializePlanDrafts } from '../../../scripts/sprites/plan-drafts.js';

describe('materializePlanDrafts', () => {
  function setupRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'crawler-plan-drafts-'));
    mkdirSync(path.join(root, 'plans', 'floor-art'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'draft'), { recursive: true });
    mkdirSync(path.join(root, 'public', 'assets', 'generated'), { recursive: true });
    return root;
  }

  it('writes canonical draft briefs using briefId when present', () => {
    const root = setupRoot();
    try {
      const planPath = path.join(root, 'plans', 'floor-art', 'rat-floor.art.yaml');
      writeFileSync(
        planPath,
        [
          'id: rat-floor',
          'title: Rat Floor',
          'assets:',
          '  - id: rat-bruiser',
          '    briefId: sewer-rat-bruiser',
          '    type: enemy',
          '    label: Sewer Rat Bruiser',
          '    brief: Sewer bruiser rat in patchwork armor.',
          '    placeholderInUse: true',
          '  - id: junk-pile',
          '    type: item',
          '    label: Junk Pile',
          '    brief: Scrap heap prop cluster.',
          '    placeholderInUse: false',
          '    briefOverrides:',
          '      tags: [item, prop, decoration]',
        ].join('\n'),
      );

      const result = materializePlanDrafts({
        repoRoot: root,
        planPath,
      });

      const enemyDraft = path.join(root, 'briefs', 'draft', 'enemies', 'sewer-rat-bruiser.yaml');
      const itemDraft = path.join(root, 'briefs', 'draft', 'items', 'junk-pile.yaml');
      expect(result.written).toHaveLength(2);
      expect(existsSync(enemyDraft)).toBe(true);
      expect(existsSync(itemDraft)).toBe(true);
      expect(readFileSync(enemyDraft, 'utf8')).toContain('name: sewer-rat-bruiser');
      expect(readFileSync(enemyDraft, 'utf8')).toContain('type: enemy');
      expect(readFileSync(itemDraft, 'utf8')).toContain('tags:');
      expect(readFileSync(itemDraft, 'utf8')).toContain('- decoration');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips existing drafts unless force is set', () => {
    const root = setupRoot();
    try {
      const planPath = path.join(root, 'plans', 'floor-art', 'rat-floor.art.yaml');
      writeFileSync(
        planPath,
        [
          'id: rat-floor',
          'title: Rat Floor',
          'assets:',
          '  - id: rat-flash',
          '    type: vfx',
          '    label: Rat Flash',
          '    brief: Quick flare.',
          '    placeholderInUse: true',
        ].join('\n'),
      );
      const draftPath = path.join(root, 'briefs', 'draft', 'vfx', 'rat-flash.yaml');
      mkdirSync(path.dirname(draftPath), { recursive: true });
      writeFileSync(draftPath, 'type: vfx\nname: rat-flash\ndescription: Existing draft\n');

      const skipped = materializePlanDrafts({
        repoRoot: root,
        planPath,
        statuses: ['draft-ready-placeholder'],
      });
      expect(skipped.written).toHaveLength(0);
      expect(skipped.skipped[0]?.reason).toBe('existing-draft');
      expect(readFileSync(draftPath, 'utf8')).toContain('Existing draft');

      const forced = materializePlanDrafts({
        repoRoot: root,
        planPath,
        statuses: ['draft-ready-placeholder'],
        force: true,
      });
      expect(forced.written).toHaveLength(1);
      expect(readFileSync(draftPath, 'utf8')).toContain('Quick flare.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
