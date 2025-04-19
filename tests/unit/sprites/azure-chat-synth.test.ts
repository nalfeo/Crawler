/**
 * Tests for the synth-provider user-prompt builder.
 *
 * `buildUserPrompt` turns a structured `SynthesizeBriefRequest` into the user
 * message sent to the chat model. The optional `briefHint` must be woven in as
 * an "Additional direction:" line ONLY when present, so existing provenance
 * (prompt text + hash) is unchanged for callers that don't supply a hint.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSystemPrompt,
  buildUserPrompt,
} from '../../../scripts/sprites/provider/azure-chat-synth.js';
import type { SynthesizeBriefRequest } from '../../../scripts/sprites/provider/synth-types.js';

function makeRequest(overrides: Partial<SynthesizeBriefRequest> = {}): SynthesizeBriefRequest {
  return {
    name: 'skull-mace',
    type: 'weapon',
    floor: 1,
    candidates: 2,
    effectiveMinSeeds: 3,
    effectiveMaxSeeds: 5,
    ...overrides,
  };
}

describe('buildUserPrompt', () => {
  it('omits the additional-direction line when no brief hint is given', () => {
    const prompt = buildUserPrompt(makeRequest());
    expect(prompt).toContain('Subject name: skull-mace.');
    expect(prompt).toContain('Sprite type: weapon.');
    expect(prompt).toContain('Floor: 1 of 20.');
    expect(prompt).toContain('Please return exactly 2 candidate brief(s).');
    expect(prompt).not.toContain('Additional direction:');
  });

  describe('buildSystemPrompt', () => {
    it('includes Floor 2 and family direction for a family sprite request', () => {
      const prompt = buildSystemPrompt(
        makeRequest({ name: 'goblin-grunt', type: 'enemy', floor: 2 }),
      );
      expect(prompt).toContain('Family Matters');
      expect(prompt).toContain('The Snaggle Cartel');
    });
  });

  it('weaves a brief hint in after the subject name and before the type line', () => {
    const prompt = buildUserPrompt(
      makeRequest({ briefHint: 'heavy two-handed, glowing green eye sockets' }),
    );
    const lines = prompt.split('\n');
    expect(lines[0]).toBe('Subject name: skull-mace.');
    expect(lines[1]).toBe('Additional direction: heavy two-handed, glowing green eye sockets');
    expect(lines[2]).toBe('Sprite type: weapon.');
  });

  it('treats a whitespace-only hint as absent', () => {
    const prompt = buildUserPrompt(makeRequest({ briefHint: '   ' }));
    expect(prompt).not.toContain('Additional direction:');
  });

  it('asks the model to classify when no type is supplied', () => {
    const prompt = buildUserPrompt(makeRequest({ type: null }));
    expect(prompt).toContain('Sprite type: classify from the name.');
  });
});
