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

  it('drains two requests concurrently through Azure OpenAI-only provider configuration', () => {
    const workflow = loadWorkflow();
    const drain = workflow.jobs.drain?.steps?.find((step) => step.name === 'Drain worker');
    expect(drain?.env).toMatchObject({
      SPRITES_WORKER_CONCURRENCY: '2',
      SPRITES_PROVIDER: 'azure-openai',
      SPRITES_TEXT_PROVIDER: 'azure-openai',
      SPRITES_SYNTH_PROVIDER: 'azure-openai',
      SPRITES_VISION_PROVIDER: 'azure-openai',
    });
    expect(
      Object.keys(drain?.env ?? {})
        .filter((key) => key.startsWith('AZURE_OPENAI_'))
        .sort(),
    ).toEqual([
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_API_VERSION',
      'AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT',
      'AZURE_OPENAI_CHAT_DEPLOYMENT',
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_IMAGE_DEPLOYMENT',
      'AZURE_OPENAI_VISION_DEPLOYMENT',
    ]);
    expect(Object.keys(drain?.env ?? {}).some((key) => key.startsWith('FOUNDRY_'))).toBe(false);
  });

  it('keeps the GitHub secret-sync command Foundry-aware', () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['setup:azure:github']).toContain('-IncludeFoundry');
    expect(packageJson.scripts?.['setup:azure:github']).toContain('-SyncGitHubSecrets');
  });
});
