import { describe, expect, it } from 'vitest';
import { extractSensorFailures } from '../../src/labs/sprite-gallery-lab/index.js';

describe('extractSensorFailures', () => {
  it('returns only failing sensors with reasons', () => {
    const candidate = {
      breakdown: [
        { ok: true, sensor: 'dimensions-exact' },
        { ok: false, sensor: 'opaque-bbox-fits', reason: 'main silhouette touches frame edge' },
        { ok: false, sensor: 'weapon-orientation', reason: 'expected diagonal' },
      ],
    } as Record<string, unknown>;

    expect(extractSensorFailures(candidate)).toEqual([
      { sensor: 'opaque-bbox-fits', reason: 'main silhouette touches frame edge' },
      { sensor: 'weapon-orientation', reason: 'expected diagonal' },
    ]);
  });

  it('ignores malformed breakdown entries', () => {
    const candidate = {
      breakdown: [{ ok: false, sensor: 'a' }, { ok: false, reason: 'missing sensor' }, null],
    } as Record<string, unknown>;

    expect(extractSensorFailures(candidate)).toEqual([]);
  });
});
