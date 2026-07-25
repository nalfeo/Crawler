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

  it('drains two requests concurrently through Azure OpenAI provider configuration', () => {
    const workflow = loadWorkflow();
    const drain = workflow.jobs.drain?.steps?.find((step) => step.name === 'Drain worker');
    expect(drain?.env).toMatchObject({
      SPRITES_WORKER_CONCURRENCY: '2',
      AZURE_OPENAI_ENDPOINT: '${{ secrets.AZURE_OPENAI_ENDPOINT }}',
      AZURE_OPENAI_API_KEY: '${{ secrets.AZURE_OPENAI_API_KEY }}',
    });
    expect(
      Object.keys(drain?.env ?? {}).some((key) => key.startsWith('FOUNDRY_')),
    ).toBe(false);
    expect(
      Object.keys(drain?.env ?? {}).some((key) => key.startsWith('AZURE_OPENAI_')),
    ).toBe(true);
  });

  it('keeps the GitHub secret-sync command Azure-aware (no -IncludeFoundry)', () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['setup:azure:github']).toContain('-SyncGitHubSecrets');
    expect(packageJson.scripts?.['setup:azure:github']).not.toContain('-IncludeFoundry');
  });
});
