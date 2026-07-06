import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
/**
 * Travel steering is now allowed to be threat-severity aware, but the PURE
 * selector must still stay pure: only the world-aware wrapper may read the
 * live hostile-damage multiplier and convert it into per-threat weights.
 */
describe('AI damage-aware travel steering', () => {
  it('only the AI world wrapper / harness read the hostile-damage multiplier', () => {
    const aiDir = fileURLToPath(new URL('../../src/game/ai/', import.meta.url));
    const ALLOWLIST = new Set([
      'bt-ai-provider.ts',
      'headless-runner.ts',
      'headless-runner-cli.ts',
    ]);
    const TOKEN = 'hostileDamageMultiplier';

    const offenders: string[] = [];
    for (const file of readdirSync(aiDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
      if (ALLOWLIST.has(file)) continue;
      const source = readFileSync(
        new URL(file, new URL('../../src/game/ai/', import.meta.url)),
        'utf-8',
      );
      if (source.includes(TOKEN)) offenders.push(file);
    }

    expect(
      offenders,
      `only the world-aware wrapper/harness may reference ${TOKEN}; pure AI modules must stay severity-input driven: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the world wrapper maps hostile-damage severity into travel threat weights', () => {
    const source = readFileSync(
      new URL('../../src/game/ai/bt-ai-provider.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toContain('dangerWeight: Math.sqrt(contactSeverity)');
    expect(source).toContain(
      'const contactSeverity = Math.max(1, contactDamage / DEFAULT_CONTACT_DAMAGE);',
    );
    expect(source).toContain('const hostileMult = world.hostileDamageMultiplier ?? 1;');
  });
});
