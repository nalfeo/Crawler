export type WeaponSwingVfxPreset = 'swingArc' | 'impactBurst' | 'volleyTrail' | 'spinRing';
export type WeaponSwingVfxKind =
  | 'weaponSwingArc'
  | 'weaponSwingImpact'
  | 'weaponSwingVolley'
  | 'weaponSwingSpin';

export interface WeaponSwingVfxSpec {
  readonly preset: WeaponSwingVfxPreset;
  readonly color: number;
  readonly intensity?: number;
}

const WEAPON_SWING_VFX_BY_ABILITY_ID: Readonly<Record<string, WeaponSwingVfxSpec>> = {
  'sword-strike-base': { preset: 'swingArc', color: 0xff6b6b, intensity: 1.0 },
  'sword-cleave': { preset: 'volleyTrail', color: 0xff8787, intensity: 1.1 },
  'sword-strike-evolved': { preset: 'impactBurst', color: 0xff4d4d, intensity: 1.2 },
  'sword-cleave-evolved': { preset: 'spinRing', color: 0xff3b3b, intensity: 1.25 },

  'dagger-rapid-strike-base': { preset: 'swingArc', color: 0xa78bfa, intensity: 1.0 },
  'dagger-flurry': { preset: 'volleyTrail', color: 0xc4b5fd, intensity: 1.1 },
  'dagger-rapid-strike-evolved': { preset: 'impactBurst', color: 0x8b5cf6, intensity: 1.2 },
  'dagger-flurry-evolved': { preset: 'spinRing', color: 0x7c3aed, intensity: 1.25 },

  'hammer-crush-base': { preset: 'swingArc', color: 0xf59e0b, intensity: 1.0 },
  'hammer-shatter': { preset: 'impactBurst', color: 0xfbbf24, intensity: 1.15 },
  'hammer-crush-evolved': { preset: 'volleyTrail', color: 0xd97706, intensity: 1.2 },
  'hammer-shatter-evolved': { preset: 'spinRing', color: 0xb45309, intensity: 1.3 },

  'bow-shot-base': { preset: 'swingArc', color: 0x34d399, intensity: 1.0 },
  'bow-piercing': { preset: 'volleyTrail', color: 0x6ee7b7, intensity: 1.1 },
  'bow-shot-evolved': { preset: 'impactBurst', color: 0x10b981, intensity: 1.2 },
  'bow-piercing-evolved': { preset: 'spinRing', color: 0x059669, intensity: 1.25 },

  'crossbow-bolt-base': { preset: 'swingArc', color: 0x60a5fa, intensity: 1.0 },
  'crossbow-barrage': { preset: 'volleyTrail', color: 0x93c5fd, intensity: 1.1 },
  'crossbow-bolt-evolved': { preset: 'impactBurst', color: 0x3b82f6, intensity: 1.2 },
  'crossbow-barrage-evolved': { preset: 'spinRing', color: 0x2563eb, intensity: 1.25 },

  'pistol-shot-base': { preset: 'swingArc', color: 0xfacc15, intensity: 1.0 },
  'pistol-volley': { preset: 'volleyTrail', color: 0xfde047, intensity: 1.1 },
  'pistol-shot-evolved': { preset: 'impactBurst', color: 0xeab308, intensity: 1.2 },
  'pistol-volley-evolved': { preset: 'spinRing', color: 0xca8a04, intensity: 1.25 },

  'throwing-toss-base': { preset: 'swingArc', color: 0x22d3ee, intensity: 1.0 },
  'throwing-boomerang': { preset: 'volleyTrail', color: 0x67e8f9, intensity: 1.1 },
  'throwing-toss-evolved': { preset: 'impactBurst', color: 0x06b6d4, intensity: 1.2 },
  'throwing-scatter': { preset: 'spinRing', color: 0x0891b2, intensity: 1.25 },

  'unarmed-punch-base': { preset: 'swingArc', color: 0xe5e7eb, intensity: 1.0 },
  'unarmed-barrage': { preset: 'volleyTrail', color: 0xf3f4f6, intensity: 1.1 },
  'unarmed-punch-evolved': { preset: 'impactBurst', color: 0xd1d5db, intensity: 1.2 },
  'unarmed-barrage-evolved': { preset: 'spinRing', color: 0x9ca3af, intensity: 1.25 },

  'sports-swing-base': { preset: 'swingArc', color: 0x38bdf8, intensity: 1.0 },
  'sports-home-run': { preset: 'impactBurst', color: 0x7dd3fc, intensity: 1.15 },
  'sports-swing-evolved': { preset: 'volleyTrail', color: 0x0ea5e9, intensity: 1.2 },
  'sports-grand-slam': { preset: 'spinRing', color: 0x0284c7, intensity: 1.3 },
};

export function getWeaponSwingVfxSpec(abilityId: string): WeaponSwingVfxSpec | undefined {
  return WEAPON_SWING_VFX_BY_ABILITY_ID[abilityId];
}

export function weaponSwingVfxKindForPreset(preset: WeaponSwingVfxPreset): WeaponSwingVfxKind {
  switch (preset) {
    case 'swingArc':
      return 'weaponSwingArc';
    case 'impactBurst':
      return 'weaponSwingImpact';
    case 'volleyTrail':
      return 'weaponSwingVolley';
    case 'spinRing':
      return 'weaponSwingSpin';
  }
}
