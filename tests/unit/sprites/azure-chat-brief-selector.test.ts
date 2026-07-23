import { describe, expect, it } from 'vitest';

import {
  AzureOpenAIBriefSelectorProvider,
  buildSystemPrompt,
} from '../../../scripts/sprites/provider/azure-chat-brief-selector.js';

describe('brief selector system prompt', () => {
  it('includes Floor 2 and family direction for a family sprite request', () => {
    const prompt = buildSystemPrompt('goblin-grunt', 2);
    expect(prompt).toContain('Family Matters');
    expect(prompt).toContain('The Snaggle Cartel');
  });
});

describe('AzureOpenAIBriefSelectorProvider', () => {
  it('classifies a structured body error as request-error', async () => {
    const provider = new AzureOpenAIBriefSelectorProvider({
      endpoint: 'https://example.openai.azure.com/',
      deployment: 'gpt-4o-mini',
      apiKey: 'test-key',
      apiVersion: '2025-04-01-preview',
      retry: { maxAttempts: 1 },
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'content_filter', message: 'blocked' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(
      provider.selectBrief({
        name: 'goblin-grunt',
        briefSentence: 'A goblin grunt.',
        floor: 2,
        candidates: [{ index: 0, description: 'A goblin with a hooked spear.' }],
      }),
    ).rejects.toMatchObject({ kind: 'request-error' });
  });
});
