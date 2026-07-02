import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Determinism guard: the status-effect framework must drive timing solely from
 * the fixed-step frame clock (`GAME.DELTA_MS`), never wall-clock or RNG. A static
 * source scan is the cheapest deterministic gate against a regression sneaking a
 * `Date.now()` / `Math.random()` into the hot path.
 *
 * Comments are stripped before scanning so the doc comments in these files — which
 * intentionally state "No Date.now(), no Math.random()" — do not trip the guard.
 */

const FRAMEWORK_FILES = [
  'src/shared/status-effect-types.ts',
  'src/core/status-effects.ts',
  'src/core/systems/statusEffectSystem.ts',
];

/** Strip block and line comments so prose mentions of the banned calls don't match. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('status-effect framework determinism', () => {
  for (const file of FRAMEWORK_FILES) {
    it(`${file} uses no wall-clock or RNG in code`, () => {
      const code = stripComments(readFileSync(file, 'utf-8'));
      expect(code).not.toMatch(/Date\.now/);
      expect(code).not.toMatch(/Math\.random/);
      expect(code).not.toMatch(/performance\.now/);
    });
  }
});
