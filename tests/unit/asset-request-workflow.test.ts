import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface AssetRequestWorkflow {
  concurrency?: { queue?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<
    string,
    {
      steps?: Array<{
        name?: string;
        env?: Record<string, string>;
      }>;
    }
  >;
}

function loadWorkflow(): AssetRequestWorkflow {
  return parse(
    readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'asset-request.yml'), 'utf8'),
  ) as AssetRequestWorkflow;
}

describe('asset-request workflow capacity', () => {
  it('uses one runner job with one active and one pending workflow run', () => {
    const workflow = loadWorkflow();
    expect(Object.keys(workflow.jobs)).toEqual(['drain']);
    expect(workflow.concurrency).toMatchObject({
      queue: 'single',
      'cancel-in-progress': false,
    });
  });

  it('drains two requests concurrently through Foundry-only provider configuration', () => {
    const workflow = loadWorkflow();
    const drain = workflow.jobs.drain?.steps?.find((step) => step.name === 'Drain worker');
    expect(drain?.env).toMatchObject({
      SPRITES_WORKER_CONCURRENCY: '2',
      SPRITES_PROVIDER: 'foundry',
      SPRITES_TEXT_PROVIDER: 'foundry',
      SPRITES_SYNTH_PROVIDER: 'foundry',
      SPRITES_VISION_PROVIDER: 'foundry',
    });
    expect(
      Object.keys(drain?.env ?? {})
        .filter((key) => key.startsWith('FOUNDRY_'))
        .sort(),
    ).toEqual([
      'FOUNDRY_API_KEY',
      'FOUNDRY_API_VERSION',
      'FOUNDRY_BRIEF_SELECTOR_MODEL',
      'FOUNDRY_ENDPOINT',
      'FOUNDRY_IMAGE_MODEL',
      'FOUNDRY_TEXT_MODEL',
      'FOUNDRY_VISION_MODEL',
    ]);
    expect(Object.keys(drain?.env ?? {}).some((key) => key.startsWith('AZURE_OPENAI_'))).toBe(
      false,
    );
  });

  it('keeps the GitHub secret-sync command Foundry-aware', () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['setup:azure:github']).toContain('-IncludeFoundry');
    expect(packageJson.scripts?.['setup:azure:github']).toContain('-SyncGitHubSecrets');
  });
});
