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

  it('drains two requests concurrently with one provider family configured', () => {
    const workflow = loadWorkflow();
    const drain = workflow.jobs.drain?.steps?.find((step) => step.name === 'Drain worker');
    const provider = drain?.env?.SPRITES_PROVIDER;
    const envKeys = Object.keys(drain?.env ?? {}).sort();

    expect(provider).toMatch(/^(foundry|azure-openai)$/);
    expect(drain?.env).toMatchObject({
      SPRITES_WORKER_CONCURRENCY: '2',
      SPRITES_PROVIDER: provider,
      SPRITES_TEXT_PROVIDER: provider,
      SPRITES_SYNTH_PROVIDER: provider,
      SPRITES_VISION_PROVIDER: provider,
    });

    if (provider === 'foundry') {
      expect(envKeys.filter((key) => key.startsWith('FOUNDRY_'))).toEqual([
        'FOUNDRY_API_KEY',
        'FOUNDRY_API_VERSION',
        'FOUNDRY_BRIEF_SELECTOR_MODEL',
        'FOUNDRY_ENDPOINT',
        'FOUNDRY_IMAGE_MODEL',
        'FOUNDRY_TEXT_MODEL',
        'FOUNDRY_VISION_MODEL',
      ]);
      expect(envKeys.some((key) => key.startsWith('AZURE_OPENAI_'))).toBe(false);
      return;
    }

    expect(envKeys.filter((key) => key.startsWith('AZURE_OPENAI_'))).toEqual([
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_API_VERSION',
      'AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT',
      'AZURE_OPENAI_CHAT_DEPLOYMENT',
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_IMAGE_DEPLOYMENT',
      'AZURE_OPENAI_VISION_DEPLOYMENT',
    ]);
    expect(envKeys.some((key) => key.startsWith('FOUNDRY_'))).toBe(false);
  });

  it('keeps the GitHub secret-sync command Foundry-aware', () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['setup:azure:github']).toContain('-IncludeFoundry');
    expect(packageJson.scripts?.['setup:azure:github']).toContain('-SyncGitHubSecrets');
  });
});
