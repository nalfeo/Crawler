import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPipelineCache,
  getActiveModules,
  getPipelineForType,
} from '../../../scripts/sprites/template-pipeline.js';

const tempDirs: string[] = [];

afterEach(() => {
  clearPipelineCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempTemplatesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crawler-template-pipeline-'));
  tempDirs.push(dir);
  return dir;
}

describe('template pipeline resolution', () => {
  it('merges parent module params with child overrides', () => {
    const dir = makeTempTemplatesDir();
    writeFileSync(
      join(dir, 'base.yml'),
      [
        'name: base-test',
        'modules:',
        '  speckle-cleanup:',
        '    type: speckle-cleanup',
        '    enabled: true',
        '    params:',
        '      mode: edge-drop',
        '      minChannel: 245',
        'pipeline:',
        '  - speckle-cleanup',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(dir, 'enemy.yml'),
      [
        'extends: base.yml',
        'name: enemy-test',
        'modules:',
        '  speckle-cleanup:',
        '    params:',
        '      mode: preserve-orphans',
        '',
      ].join('\n'),
      'utf8',
    );

    const pipeline = getPipelineForType('enemy', dir);
    const active = getActiveModules(pipeline, 'enemy');
    const speckle = active.find((m) => m.name === 'speckle-cleanup');
    expect(speckle).toBeDefined();
    expect(speckle?.config.type).toBe('speckle-cleanup');
    expect(speckle?.config.params.mode).toBe('preserve-orphans');
    expect(speckle?.config.params.minChannel).toBe(245);
  });

  it('keys cache by templates directory and sprite type', () => {
    const dirA = makeTempTemplatesDir();
    writeFileSync(
      join(dirA, 'enemy.yml'),
      [
        'name: pipeline-a',
        'modules:',
        '  alpha-threshold:',
        '    type: alpha-threshold',
        '    enabled: true',
        '    params: {}',
        'pipeline:',
        '  - alpha-threshold',
        '',
      ].join('\n'),
      'utf8',
    );

    const dirB = makeTempTemplatesDir();
    writeFileSync(
      join(dirB, 'enemy.yml'),
      [
        'name: pipeline-b',
        'modules:',
        '  alpha-threshold:',
        '    type: alpha-threshold',
        '    enabled: true',
        '    params: {}',
        'pipeline:',
        '  - alpha-threshold',
        '',
      ].join('\n'),
      'utf8',
    );

    const pipelineA = getPipelineForType('enemy', dirA);
    const pipelineB = getPipelineForType('enemy', dirB);
    expect(pipelineA.name).toBe('pipeline-a');
    expect(pipelineB.name).toBe('pipeline-b');
  });

  it('equipment and prop use the production templates without ENOENT', () => {
    // Regression: equipment.yml and prop.yml were missing when the types were
    // added to SPRITE_TYPES, causing ENOENT failures during post-processing.
    // This test uses the real production templates directory.
    for (const type of ['equipment', 'prop'] as const) {
      const pipeline = getPipelineForType(type);
      expect(pipeline).toBeDefined();
      expect(typeof pipeline.name).toBe('string');
      // Verify the pipeline has at least one module step, confirming inheritance
      // from base.yml was applied correctly.
      expect(pipeline.pipeline.length).toBeGreaterThan(0);
    }
  });
});
