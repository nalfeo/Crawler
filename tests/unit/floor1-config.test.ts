import { describe, expect, it } from 'vitest';
import {
  floor1Config,
  getFloorConfig,
  loadFloorConfigFromManifest,
  loadFloor1ConfigFromManifest,
} from '../../src/shared/floor-config.js';
import {
  STARTER_WEAPON_ID_TO_ITEM_ID,
  getEquipmentDefForStarterWeapon,
} from '../../src/shared/equipmentDefs.js';
import { getItemById } from '../../src/shared/items.js';

describe('floor1Config', () => {
  it('should load and validate the manifest-derived floor1 config', () => {
    expect(floor1Config).toBeDefined();
    expect(floor1Config.protagonist).toBe('Rhea Vale');
    expect(floor1Config.starterWeapons).toHaveLength(6);
    expect(floor1Config.starterWeapons).toContain('sword');
    expect(floor1Config.starterWeapons).toContain('bow');
    expect(floor1Config.starterWeapons).toContain('baseball-bat');
    expect(floor1Config.starterWeapons).toContain('pistol');
    expect(floor1Config.starterWeapons).toContain('throwing-knife');
    expect(floor1Config.starterWeapons).toContain('fireball');
  });

  it('uses canonical same-id identities across starter equipment that bypass shop aliases', () => {
    for (const weaponId of ['throwing-knife', 'fireball', 'laser', 'punch', 'landmine']) {
      expect(STARTER_WEAPON_ID_TO_ITEM_ID.get(weaponId)).toBe(weaponId);
      expect(getEquipmentDefForStarterWeapon(weaponId)?.weaponId).toBe(weaponId);
      expect(getItemById(weaponId)?.name).toBe(getEquipmentDefForStarterWeapon(weaponId)?.name);
    }
  });

  it('should have valid timer configuration', () => {
    expect(floor1Config.timer.durationMs).toBe(600_000);
    expect(floor1Config.timer.stairSpawnCountdownMs).toBe(30_000);
  });

  it('should have valid objective requirements', () => {
    expect(floor1Config.objectives.requiredRats).toBe(6);
    expect(floor1Config.objectives.requiredSlimes).toBe(4);
    expect(floor1Config.objectives.requiredTotalKills).toBe(10);
    expect(floor1Config.objectives.requiredGold).toBe(15);
    expect(floor1Config.objectives.requiredJunk).toBe(2);
    expect(floor1Config.objectives.markerRadiusFt).toBe(24);
  });

  it('should have valid map configuration', () => {
    expect(floor1Config.map.widthTiles).toBe(240);
    expect(floor1Config.map.heightTiles).toBe(140);
    expect(floor1Config.map.tileSizeFt).toBe(4);
    expect(floor1Config.map.seed).toBe(42);
    expect(floor1Config.map.roomWidthRange).toEqual([10, 22]);
    expect(floor1Config.map.roomHeightRange).toEqual([9, 20]);
    expect(floor1Config.map.maxRooms).toBe(70);
    expect(floor1Config.map.floorDensity).toBe(0.36);
  });

  it('should have valid enemy configurations', () => {
    expect(floor1Config.enemies.rat.hp).toBe(20);
    expect(floor1Config.enemies.rat.speed).toBe(0.15625);
    expect(floor1Config.enemies.rat.detectRange).toBe(52.5);
    expect(floor1Config.enemies.rat.spawnWeight).toBe(0.62);
    expect(floor1Config.enemies.rat.spriteTexture).toBe(1);

    expect(floor1Config.enemies.slime.hp).toBe(30);
    expect(floor1Config.enemies.slime.speed).toBe(0.1125);
    expect(floor1Config.enemies.slime.detectRange).toBe(40);
    expect(floor1Config.enemies.slime.spriteTexture).toBe(2);

    expect(floor1Config.enemies.boss.hp).toBe(280);
    expect(floor1Config.enemies.boss.speed).toBe(0.14375);
    expect(floor1Config.enemies.boss.detectRange).toBe(67.5);
  });

  it('should have valid boss variant configurations', () => {
    expect(floor1Config.bossVariants).toBeDefined();
    expect(floor1Config.bossVariants!.slimeRat.hp).toBe(140);
    expect(floor1Config.bossVariants!.slimeRat.speed).toBe(0.125);
    expect(floor1Config.bossVariants!.slimeRat.detectRange).toBe(55);
    expect(floor1Config.bossVariants!.slimeRat.fireballCooldownMs).toBe(7000);

    expect(floor1Config.bossVariants!.ratSlime.hp).toBe(280);
    expect(floor1Config.bossVariants!.ratSlime.speed).toBe(0.14375);
    expect(floor1Config.bossVariants!.ratSlime.detectRange).toBe(67.5);
    expect(floor1Config.bossVariants!.ratSlime.fireballCooldownMs).toBe(5000);
  });

  it('should have valid spawning configuration', () => {
    expect(floor1Config.spawning.enemyCap).toBe(100);
    expect(floor1Config.spawning.spawnIntervalMs).toBe(500);
    expect(floor1Config.spawning.spawnRadiusMin).toBe(20);
    expect(floor1Config.spawning.ambientSpawnMaxDistanceFt).toBe(160);
    expect(floor1Config.spawning.ambientDespawnDistanceFt).toBe(300);
  });

  it('should have valid player bonuses', () => {
    expect(floor1Config.player.hpBonus).toBe(20);
    expect(floor1Config.player.moveSpeedBonus).toBe(0.025);
    expect(floor1Config.player.pickupRangeBonus).toBe(1);
  });

  it('should have valid camera configuration', () => {
    expect(floor1Config.camera.zoom).toBe(2.0);
  });

  it('should have valid sprite configuration', () => {
    expect(floor1Config.sprites).toBeDefined();
    expect(floor1Config.sprites!.welcomeSign).toBe(3);
  });

  it('should carry the per-floor ambient lighting default', () => {
    expect(floor1Config.lighting).toBeDefined();
    expect(floor1Config.lighting.ambient).toBe(0.2);
  });
});

describe('loadFloorConfigFromManifest', () => {
  it('returns null for an unknown floor id', () => {
    expect(loadFloorConfigFromManifest('floor99')).toBeNull();
  });

  it('returns a config object for a known floor id', () => {
    const config = loadFloorConfigFromManifest('floor1');
    expect(config).not.toBeNull();
    expect(config!.protagonist).toBe('Rhea Vale');
  });
});

describe('getFloorConfig', () => {
  it('throws for an unknown floor id', () => {
    expect(() => getFloorConfig('floor99')).toThrow('Floor configuration not found: floor99');
  });

  it('returns the config for a known floor id', () => {
    const config = getFloorConfig('floor1');
    expect(config).toBeDefined();
    expect(config.protagonist).toBe('Rhea Vale');
  });
});

describe('loadFloor1ConfigFromManifest (deprecated compat)', () => {
  it('returns the same data as getFloorConfig("floor1")', () => {
    const deprecated = loadFloor1ConfigFromManifest();
    const canonical = getFloorConfig('floor1');
    expect(deprecated.protagonist).toBe(canonical.protagonist);
    expect(deprecated.starterWeapons).toEqual(canonical.starterWeapons);
  });
});
