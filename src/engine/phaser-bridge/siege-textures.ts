import type Phaser from 'phaser';

/** Explicit silhouettes keep temporary siege art readable without relying on team color. */
export const SIEGE_TEXTURE_KEYS = {
  siege_allied_minion: '__cw_siege_allied_minion',
  enemy_siege_minion: '__cw_enemy_siege_minion',
  enemy_siege_hero: '__cw_enemy_siege_hero',
  siege_ram: '__cw_siege_ram',
  siege_command_post: '__cw_siege_command_post',
  siege_allied_checkpoint: '__cw_siege_allied_checkpoint',
  siege_enemy_checkpoint: '__cw_siege_enemy_checkpoint',
  siege_outer_wall: '__cw_siege_outer_wall',
  siege_route_marker: '__cw_siege_route_marker',
} as const;

export function generateSiegeTextures(g: Phaser.GameObjects.Graphics): void {
  const ink = 0x111827;
  const ally = 0x67e8f9;
  const hostile = 0xfb7185;
  const gold = 0xfbbf24;

  // Ally: a cyan shield with a white cross, flat top and pointed base.
  g.clear();
  g.fillStyle(ink, 1);
  g.fillRect(3, 2, 24, 17);
  g.fillTriangle(3, 18, 27, 18, 15, 30);
  g.fillStyle(ally, 1);
  g.fillRect(6, 5, 18, 12);
  g.fillTriangle(6, 17, 24, 17, 15, 26);
  g.fillStyle(0xecfeff, 1);
  g.fillRect(13, 8, 4, 13);
  g.fillRect(9, 12, 12, 4);
  g.generateTexture(SIEGE_TEXTURE_KEYS.siege_allied_minion, 30, 32);

  // Hostile: a pointed helmet, broad angular shoulders and a dark visor.
  g.clear();
  g.fillStyle(ink, 1);
  g.fillTriangle(15, 1, 1, 27, 29, 27);
  g.fillStyle(hostile, 1);
  g.fillTriangle(15, 5, 5, 25, 25, 25);
  g.fillStyle(ink, 1);
  g.fillRect(10, 16, 10, 4);
  g.generateTexture(SIEGE_TEXTURE_KEYS.enemy_siege_minion, 30, 30);

  // Hero: larger crimson mantle beneath an unmistakable three-point gold crown.
  g.clear();
  g.fillStyle(ink, 1);
  g.fillTriangle(20, 7, 2, 38, 38, 38);
  g.fillStyle(0xbe123c, 1);
  g.fillTriangle(20, 11, 6, 35, 34, 35);
  g.fillStyle(gold, 1);
  g.fillRect(10, 9, 20, 8);
  g.fillTriangle(10, 10, 9, 2, 17, 10);
  g.fillTriangle(15, 10, 20, 0, 25, 10);
  g.fillTriangle(23, 10, 31, 2, 30, 10);
  g.fillStyle(0xffe4e6, 1);
  g.fillRect(15, 21, 10, 4);
  g.generateTexture(SIEGE_TEXTURE_KEYS.enemy_siege_hero, 40, 40);

  // Ram: a horizontal timber on a four-wheel cyan carriage, gold striking head.
  g.clear();
  g.fillStyle(ink, 1);
  for (const x of [10, 34]) {
    g.fillCircle(x, 7, 6);
    g.fillCircle(x, 27, 6);
  }
  g.fillStyle(ally, 1);
  g.fillRect(6, 9, 34, 16);
  g.fillStyle(0x78513a, 1);
  g.fillRect(2, 13, 40, 8);
  g.fillStyle(gold, 1);
  g.fillRect(39, 10, 7, 14);
  g.fillStyle(0xfffbeb, 1);
  g.fillRect(43, 12, 3, 10);
  g.generateTexture(SIEGE_TEXTURE_KEYS.siege_ram, 48, 34);

  // Command Post: fortified square tower with a tall cyan command flag.
  g.clear();
  g.fillStyle(ink, 1);
  g.fillRect(2, 19, 36, 27);
  g.fillStyle(0x64748b, 1);
  g.fillRect(5, 22, 30, 21);
  g.fillStyle(ally, 1);
  for (const x of [5, 17, 29]) g.fillRect(x, 17, 6, 8);
  g.fillRect(18, 3, 3, 20);
  g.fillRect(21, 3, 15, 10);
  g.fillStyle(ink, 1);
  g.fillRect(16, 31, 8, 12);
  g.generateTexture(SIEGE_TEXTURE_KEYS.siege_command_post, 40, 48);

  // Checkpoints: raised flag on a low plinth; square ally flag / split hostile pennant.
  for (const allied of [true, false]) {
    g.clear();
    g.fillStyle(ink, 1);
    g.fillRect(3, 29, 28, 8);
    g.fillStyle(0x94a3b8, 1);
    g.fillRect(6, 30, 22, 4);
    g.fillRect(8, 3, 3, 28);
    g.fillStyle(allied ? ally : hostile, 1);
    if (allied) g.fillRect(11, 4, 17, 12);
    else {
      g.fillTriangle(11, 3, 29, 3, 11, 10);
      g.fillTriangle(11, 10, 29, 17, 11, 17);
    }
    g.generateTexture(
      allied
        ? SIEGE_TEXTURE_KEYS.siege_allied_checkpoint
        : SIEGE_TEXTURE_KEYS.siege_enemy_checkpoint,
      34,
      38,
    );
  }

  g.clear();
  g.fillStyle(ink, 1);
  g.fillRect(1, 3, 46, 22);
  g.fillStyle(0x94a3b8, 1);
  for (const x of [3, 19, 35]) g.fillRect(x, 5, 12, 8);
  for (const x of [3, 14, 30]) g.fillRect(x, 15, x === 3 ? 7 : 12, 8);
  g.generateTexture(SIEGE_TEXTURE_KEYS.siege_outer_wall, 48, 26);

  g.clear();
  g.lineStyle(2, gold, 0.8);
  g.strokeCircle(7, 7, 5);
  g.generateTexture(SIEGE_TEXTURE_KEYS.siege_route_marker, 14, 14);
}
