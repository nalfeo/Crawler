/** Mob Definition Schema — data-driven enemy/creature configuration.
 *
 * Every mob type is described by a small, reviewable MobDef struct.
 * The same machinery scales from common grunts to boss encounters.
 */

export interface MobDef {
  readonly id: string;
  readonly name: string;
  readonly baseHp: number;
  readonly baseSpeed: number;
  readonly baseDamage: number;
  readonly sizeCategory: 'small' | 'medium' | 'large' | 'boss';
  readonly aiPattern: 'chase' | 'patrol' | 'ranged' | 'melee' | 'mixed';
  readonly rarity: 'common' | 'rare' | 'elite' | 'legendary';
  /** Reference to loot table ID (e.g., "zombie-drops"). */
  readonly lootTableId: string;
  /** Reference to sprite catalog entry. */
  readonly spriteId: string;
  /** Damage knockback multiplier (0 = no knockback). */
  readonly knockbackMult: number;
  /** Gore factor 0..1 — blood splatter intensity on hit. */
  readonly goreFactor: number;
  /** Ability slot count (0 = no special abilities). */
  readonly abilitySlots: number;
  /** XP reward multiplier (1.0 = standard). */
  readonly xpMultiplier: number;
}

function def(
  partial: Partial<MobDef> &
    Pick<
      MobDef,
      'id' | 'name' | 'baseHp' | 'baseSpeed' | 'baseDamage' | 'sizeCategory' | 'aiPattern'
    >,
): MobDef {
  return {
    rarity: 'common',
    lootTableId: 'common-drops',
    spriteId: 'mob-placeholder',
    knockbackMult: 1.0,
    goreFactor: 0.5,
    abilitySlots: 0,
    xpMultiplier: 1.0,
    ...partial,
  };
}

export const MOB_DEFS: ReadonlyMap<string, MobDef> = new Map([
  // --- Common Grunts ---
  [
    'zombie',
    def({
      id: 'zombie',
      name: 'Zombie',
      baseHp: 20,
      baseSpeed: 1.2,
      baseDamage: 5,
      sizeCategory: 'small',
      aiPattern: 'chase',
      rarity: 'common',
      lootTableId: 'zombie-drops',
      spriteId: 'mob-zombie',
      knockbackMult: 0.5,
      goreFactor: 0.8,
      xpMultiplier: 1.0,
    }),
  ],
  [
    'skeleton',
    def({
      id: 'skeleton',
      name: 'Skeleton',
      baseHp: 18,
      baseSpeed: 1.5,
      baseDamage: 6,
      sizeCategory: 'small',
      aiPattern: 'melee',
      rarity: 'common',
      lootTableId: 'skeleton-drops',
      spriteId: 'mob-skeleton',
      knockbackMult: 0.8,
      goreFactor: 0.2,
      xpMultiplier: 1.1,
    }),
  ],
  [
    'goblin',
    def({
      id: 'goblin',
      name: 'Goblin',
      baseHp: 15,
      baseSpeed: 2.0,
      baseDamage: 4,
      sizeCategory: 'small',
      aiPattern: 'mixed',
      rarity: 'common',
      lootTableId: 'goblin-drops',
      spriteId: 'mob-goblin',
      knockbackMult: 1.2,
      goreFactor: 0.6,
      xpMultiplier: 0.9,
    }),
  ],

  // --- Rare Variants ---
  [
    'reaver',
    def({
      id: 'reaver',
      name: 'Reaver',
      baseHp: 35,
      baseSpeed: 2.2,
      baseDamage: 10,
      sizeCategory: 'medium',
      aiPattern: 'ranged',
      rarity: 'rare',
      lootTableId: 'rare-drops',
      spriteId: 'mob-reaver',
      knockbackMult: 0.6,
      goreFactor: 0.9,
      abilitySlots: 1,
      xpMultiplier: 1.5,
    }),
  ],
  [
    'wraith',
    def({
      id: 'wraith',
      name: 'Wraith',
      baseHp: 30,
      baseSpeed: 2.5,
      baseDamage: 8,
      sizeCategory: 'medium',
      aiPattern: 'mixed',
      rarity: 'rare',
      lootTableId: 'rare-drops',
      spriteId: 'mob-wraith',
      knockbackMult: 0.3,
      goreFactor: 0.1,
      abilitySlots: 2,
      xpMultiplier: 1.6,
    }),
  ],

  // --- Elite Heavy ---
  [
    'goliath',
    def({
      id: 'goliath',
      name: 'Goliath',
      baseHp: 80,
      baseSpeed: 0.8,
      baseDamage: 16,
      sizeCategory: 'large',
      aiPattern: 'melee',
      rarity: 'elite',
      lootTableId: 'elite-drops',
      spriteId: 'mob-goliath',
      knockbackMult: 0.4,
      goreFactor: 0.7,
      abilitySlots: 1,
      xpMultiplier: 2.0,
    }),
  ],
  [
    'mage-lord',
    def({
      id: 'mage-lord',
      name: 'Mage Lord',
      baseHp: 60,
      baseSpeed: 1.5,
      baseDamage: 12,
      sizeCategory: 'large',
      aiPattern: 'ranged',
      rarity: 'elite',
      lootTableId: 'elite-drops',
      spriteId: 'mob-mage-lord',
      knockbackMult: 0.5,
      goreFactor: 0.2,
      abilitySlots: 3,
      xpMultiplier: 2.2,
    }),
  ],

  // --- Neighborhood Boss (Tutorial) ---
  [
    'slime-rat',
    def({
      id: 'slime-rat',
      name: 'Slime Rat',
      baseHp: 45,
      baseSpeed: 1.3,
      baseDamage: 8,
      sizeCategory: 'boss',
      aiPattern: 'melee',
      rarity: 'elite',
      lootTableId: 'boss-drops',
      spriteId: 'mob-placeholder',
      knockbackMult: 0.6,
      goreFactor: 0.4,
      abilitySlots: 0,
      xpMultiplier: 2.5,
    }),
  ],

  // --- Boss ---
  [
    'directors-proxy',
    def({
      id: 'directors-proxy',
      name: "The Director's Proxy",
      baseHp: 200,
      baseSpeed: 1.8,
      baseDamage: 25,
      sizeCategory: 'boss',
      aiPattern: 'mixed',
      rarity: 'legendary',
      lootTableId: 'boss-drops',
      spriteId: 'mob-directors-proxy',
      knockbackMult: 0.2,
      goreFactor: 0.0,
      abilitySlots: 5,
      xpMultiplier: 5.0,
    }),
  ],
]);

export function getMobDef(id: string): MobDef | undefined {
  return MOB_DEFS.get(id);
}
