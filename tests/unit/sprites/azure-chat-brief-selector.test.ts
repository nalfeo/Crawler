import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from '../../../scripts/sprites/provider/azure-chat-brief-selector.js';

describe('brief selector system prompt', () => {
  it('includes Floor 2 and family direction for a family sprite request', () => {
    const prompt = buildSystemPrompt('goblin-grunt', 2);
    expect(prompt).toContain('Family Matters');
    expect(prompt).toContain('The Snaggle Cartel');
  });
});
