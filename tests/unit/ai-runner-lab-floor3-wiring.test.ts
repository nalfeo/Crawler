import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  getAvailableFloorIds,
  getNextFloorId,
  hasFloorManifest,
  isFloorImplemented,
} from '../../src/shared/floor-registry.js';
import { isFloorPlayable } from '../../src/game/scenarioDefinitions.js';

describe('AI runner lab Floor 3 wiring', () => {
  it('offers Floor 3 as a selectable, manifest-backed runner floor', () => {
    // The lab's floor dropdown is built from getAvailableFloorIds(), and its
    // debug snapshot labels the live floor from hasFloorManifest(), so both
    // registry answers are the lab's actual contract for Floor 3.
    expect(getAvailableFloorIds()).toContain('floor3');
    expect(hasFloorManifest('floor3')).toBe(true);
    expect(isFloorPlayable('floor3')).toBe(true);
    // Floor 3's terminal objective is unbuilt, so it must stay out of the
    // implemented/win-chain set that sweeps and win-rate gates measure.
    expect(isFloorImplemented('floor3')).toBe(false);
    expect(getNextFloorId('floor2')).toBe('floor3');
  });

  it('labels the live floor from the registry instead of a floor1/floor2 union', () => {
    // Intentional canary test: follows the existing ai-runner wiring guards that
    // read the source file and assert critical integration strings. Guards the
    // regression where the debug snapshot reported 'unknown' for any floor
    // outside a hardcoded floor1|floor2 union.
    const source = readFileSync(
      new URL('../../src/labs/ai-runner-lab/index.ts', import.meta.url),
      'utf-8',
    );

    expect(source).toMatch(/hasFloorManifest\(world\.floorId\)\s*\?\s*world\.floorId/);
    expect(source).not.toMatch(/effectiveFloor:\s*'floor1'\s*\|\s*'floor2'/);
    // The automatic in-process floor transition must stay destination-agnostic
    // so a cleared Floor 2 recomposes straight into Floor 3.
    expect(source).toMatch(
      /const destinationFloorId = nextFloorOptions\.floorId \?\? currentFloor/,
    );
  });
});
