import { describe, expect, it } from 'vitest';
import { floor1Config } from '../../src/shared/floor1-config.js';

describe('floor1Config', () => {
  it('should load and validate floor1.json', () => {
    expect(floor1Config).toBeDefined();
    expect(floor1Config.protagonist).toBe('Rhea Vale');
    expect(floor1Config.starterWeapons).toHaveLength(5);
    expect(floor1Config.starterWeapons).toContain('sword');
    expect(floor1Config.starterWeapons).toContain('pistol');
  });

  it('should have valid timer configuration', () => {
    expect(floor1Config.timer.durationMs).toBe(300_000);
    expect(floor1Config.timer.stairSpawnCountdownMs).toBe(30_000);
  });

  it('should have valid objective requirements', () => {
    expect(floor1Config.objectives.requiredRats).toBe(6);
    expect(floor1Config.objectives.requiredSlimes).toBe(4);
    expect(floor1Config.objectives.requiredTotalKills).toBe(10);
    expect(floor1Config.objectives.requiredGold).toBe(15);
    expect(floor1Config.objectives.requiredJunk).toBe(2);
    expect(floor1Config.objectives.markerRadiusPx).toBe(64);
  });

  it('should have valid map configuration', () => {
    expect(floor1Config.map.widthTiles).toBe(120);
    expect(floor1Config.map.heightTiles).toBe(70);
    expect(floor1Config.map.tileSizePx).toBe(32);
    expect(floor1Config.map.seed).toBe(42);
    expect(floor1Config.map.roomWidthRange).toEqual([6, 14]);
    expect(floor1Config.map.roomHeightRange).toEqual([5, 13]);
    expect(floor1Config.map.maxRooms).toBe(45);
    expect(floor1Config.map.floorDensity).toBe(0.42);
  });

  it('should have valid enemy configurations', () => {
    expect(floor1Config.enemies.rat.hp).toBe(20);
    expect(floor1Config.enemies.rat.speed).toBe(1.25);
    expect(floor1Config.enemies.rat.detectRange).toBe(420);
    expect(floor1Config.enemies.rat.spawnWeight).toBe(0.62);
    expect(floor1Config.enemies.rat.spriteTexture).toBe(1);

    expect(floor1Config.enemies.slime.hp).toBe(30);
    expect(floor1Config.enemies.slime.speed).toBe(0.9);
    expect(floor1Config.enemies.slime.detectRange).toBe(320);
    expect(floor1Config.enemies.slime.spriteTexture).toBe(2);

    expect(floor1Config.enemies.boss.hp).toBe(280);
    expect(floor1Config.enemies.boss.speed).toBe(1.15);
    expect(floor1Config.enemies.boss.detectRange).toBe(540);
  });

  it('should have valid boss variant configurations', () => {
    expect(floor1Config.bossVariants).toBeDefined();
    expect(floor1Config.bossVariants!.slimeRat.hp).toBe(140);
    expect(floor1Config.bossVariants!.slimeRat.speed).toBe(1.0);
    expect(floor1Config.bossVariants!.slimeRat.detectRange).toBe(440);
    expect(floor1Config.bossVariants!.slimeRat.fireballCooldownMs).toBe(7000);

    expect(floor1Config.bossVariants!.ratSlime.hp).toBe(280);
    expect(floor1Config.bossVariants!.ratSlime.speed).toBe(1.15);
    expect(floor1Config.bossVariants!.ratSlime.detectRange).toBe(540);
    expect(floor1Config.bossVariants!.ratSlime.fireballCooldownMs).toBe(5000);
  });

  it('should have valid spawning configuration', () => {
    expect(floor1Config.spawning.enemyCap).toBe(14);
    expect(floor1Config.spawning.spawnIntervalMs).toBe(900);
    expect(floor1Config.spawning.spawnRadiusMin).toBe(160);
    expect(floor1Config.spawning.ambientSpawnMaxDistancePx).toBe(1280);
    expect(floor1Config.spawning.ambientDespawnDistancePx).toBe(1920);
  });

  it('should have valid player bonuses', () => {
    expect(floor1Config.player.hpBonus).toBe(20);
    expect(floor1Config.player.moveSpeedBonus).toBe(0.2);
    expect(floor1Config.player.pickupRangeBonus).toBe(8);
  });

  it('should have valid camera configuration', () => {
    expect(floor1Config.camera.zoom).toBe(2.0);
  });

  it('should have valid sprite configuration', () => {
    expect(floor1Config.sprites).toBeDefined();
    expect(floor1Config.sprites!.welcomeSign).toBe(3);
  });
});
