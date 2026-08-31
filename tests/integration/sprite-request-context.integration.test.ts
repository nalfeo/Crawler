import { describe, expect, it } from 'vitest';

import { resolveAssetRequestContext } from '../../scripts/sprites/asset-request-context.js';
import { synthesizeBrief } from '../../scripts/sprites/synthesize-brief.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
} from '../../scripts/sprites/provider/azure-chat-synth.js';
import type {
  SynthesizeBriefRequest,
  SynthProvider,
} from '../../scripts/sprites/provider/synth-types.js';

describe('sprite request context integration', () => {
  it('carries a Floor 2 family, role, and request-local injection into candidate YAML and synth prompts', async () => {
    const context = resolveAssetRequestContext({
      floor: 2,
      floorId: 'floor2',
      familyId: 'goblins',
      mobRole: 'elite',
      injectionOverrides: { family: 'OVERRIDE: disciplined emerald scrapyard scouts.' },
    });
    const writes = new Map<string, string>();
    let request: SynthesizeBriefRequest | undefined;
    const provider: SynthProvider = {
      providerLabel: 'test:synth',
      async synthesizeBrief(input) {
        request = input;
        return {
          inferredType: null,
          typeConfidence: null,
          candidates: [
            {
              description:
                'A crouched goblin scout with an oversized spyglass and patched leather satchel.',
              embellishmentSeeds: [
                'brass spyglass cap',
                'torn green gang pennant',
                'bent salvage badge',
              ],
              rationale: 'The spyglass makes the scout role readable at gameplay scale.',
            },
          ],
        };
      },
    };

    const result = await synthesizeBrief({
      name: 'goblin-elite-scout',
      type: 'enemy',
      floor: 2,
      mobRole: 'elite',
      assetRequestContext: context,
      requestMetadata: { priority: 'high', requester: 'github-author' },
      candidates: 1,
      provider,
      repoRoot: process.cwd(),
      outputRoot: '/virtual',
      env: {},
      fsWrites: {
        mkdir() {},
        writeFile(filePath, contents) {
          writes.set(filePath, contents);
        },
      },
      loadMinVariations: () => 3,
    });

    expect(result.written).toHaveLength(1);
    const yaml = [...writes.entries()].find(([file]) => file.endsWith('.yaml'))?.[1] ?? '';
    expect(yaml).toContain('mobRole: elite');
    expect(yaml).toContain('floorId: floor2');
    expect(yaml).toContain('familyId: goblins');
    expect(yaml).toContain('family: "OVERRIDE: disciplined emerald scrapyard scouts."');
    expect(yaml).toContain('priority: high');
    expect(yaml).toContain('requester: github-author');

    expect(request?.assetRequestContext).toEqual(context);
    expect(buildSystemPrompt(request!)).toContain(
      'OVERRIDE: disciplined emerald scrapyard scouts.',
    );
    expect(buildUserPrompt(request!)).toContain('floorId=floor2');
    expect(buildUserPrompt(request!)).toContain('Mob role: elite.');
  });
});
