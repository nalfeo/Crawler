import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  computeActiveWeaponSnapshotFingerprint,
  createActiveWeaponSnapshotV1,
  generatedEquipmentInstanceKey,
} from '../../src/core/generated-equipment-registry.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';

describe('active weapon snapshot properties', () => {
  it('is deterministic for equal inputs and fingerprints drift when combat fields drift', () => {
    const fireball = getWeaponDef('fireball');
    if (!fireball) throw new Error('Expected fireball weapon definition');

    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,24}$/),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 1_500 }),
        (runKey, baseDamageBonus, cooldownMs) => {
          const instanceId = generatedEquipmentInstanceKey(runKey, 0);
          const left = createActiveWeaponSnapshotV1({ instanceId }, fireball, {
            baseDamage: fireball.baseDamage + baseDamageBonus,
            cooldownMs,
          });
          const right = createActiveWeaponSnapshotV1({ instanceId }, fireball, {
            baseDamage: fireball.baseDamage + baseDamageBonus,
            cooldownMs,
          });
          const drifted = createActiveWeaponSnapshotV1({ instanceId }, fireball, {
            baseDamage: fireball.baseDamage + baseDamageBonus + 1,
            cooldownMs,
          });
          const { fingerprint, ...leftWithoutFingerprint } = left;

          expect(left).toEqual(right);
          expect(left.fingerprint).toBe(right.fingerprint);
          expect(computeActiveWeaponSnapshotFingerprint(leftWithoutFingerprint)).toBe(fingerprint);
          expect(drifted.fingerprint).not.toBe(left.fingerprint);
        },
      ),
    );
  });
});
