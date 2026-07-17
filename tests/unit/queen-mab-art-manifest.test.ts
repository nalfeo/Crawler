import { describe, expect, it } from 'vitest';
import {
  QUEEN_MAB_ART_MANIFEST,
  REQUIRED_VISUAL_PHASE_IDS,
  loadQueenMabArtManifest,
  queenMabArtManifestSchema,
} from '../../scripts/agent/queen-mab-art-manifest-lib.js';

describe('Queen Mab generated-art manifest', () => {
  it('parses and validates the committed manifest', () => {
    expect(() => loadQueenMabArtManifest()).not.toThrow();
    expect(QUEEN_MAB_ART_MANIFEST.schemaVersion).toBe('mob-ability-art-manifest/v1');
    expect(QUEEN_MAB_ART_MANIFEST.generatedArtScope).toBe('queen-mab-only');
  });

  it('declares every required visual phase with a procedural fallback', () => {
    const phaseIds = new Set(
      QUEEN_MAB_ART_MANIFEST.requiredVisualPhases.map((phase) => phase.phaseId),
    );
    for (const requiredPhaseId of REQUIRED_VISUAL_PHASE_IDS) {
      expect(phaseIds.has(requiredPhaseId)).toBe(true);
    }
    for (const phase of QUEEN_MAB_ART_MANIFEST.requiredVisualPhases) {
      expect(phase.proceduralFallback.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps every generated-art asset non-blocking for the arena slice', () => {
    expect(QUEEN_MAB_ART_MANIFEST.assets.length).toBeGreaterThan(0);
    for (const asset of QUEEN_MAB_ART_MANIFEST.assets) {
      expect(asset.blockingForArena).toBe(false);
      expect(asset.proceduralFallback.trim().length).toBeGreaterThan(0);
    }
  });

  it('is scoped to Queen Mab only', () => {
    for (const asset of QUEEN_MAB_ART_MANIFEST.assets) {
      expect(asset.bossId).toBe('queen-mab-tarnish');
      expect(asset.abilityId).toBe('queen-mab-verdigris-glamour');
    }
  });

  it('rejects a blocking asset', () => {
    const bad = structuredClone(QUEEN_MAB_ART_MANIFEST) as unknown as Record<string, unknown>;
    (bad.assets as Array<Record<string, unknown>>)[0].blockingForArena = true;
    expect(() => queenMabArtManifestSchema.parse(bad)).toThrow();
  });

  it('rejects an asset referencing an unknown visual phase', () => {
    const bad = structuredClone(QUEEN_MAB_ART_MANIFEST) as unknown as Record<string, unknown>;
    (bad.assets as Array<Record<string, unknown>>)[0].coversPhaseId = 'no-such-phase';
    expect(() => queenMabArtManifestSchema.parse(bad)).toThrow();
  });

  it('rejects a manifest missing a required visual phase', () => {
    const bad = structuredClone(QUEEN_MAB_ART_MANIFEST) as unknown as {
      requiredVisualPhases: unknown[];
    };
    bad.requiredVisualPhases = bad.requiredVisualPhases.filter(
      (phase) => (phase as { phaseId: string }).phaseId !== 'resolution-burst',
    );
    expect(() => loadQueenMabArtManifest(bad)).toThrow(/resolution-burst/);
  });
});
