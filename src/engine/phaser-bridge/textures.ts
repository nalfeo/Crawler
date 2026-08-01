import type Phaser from 'phaser';
import { createLogger } from '../../shared/logger.js';

/**
 * Procedural fallback textures for {@link createPhaserBridge}.
 *
 * Every `__cw_*` texture is baked once per scene into the Phaser texture
 * manager so the renderer always has a placeholder to draw even when no Kenney
 * sprite-sheet or approved generated PNG is loaded. Extracted verbatim from
 * `PhaserBridge.ts` (behavior-preserving) so the facade can stay focused on the
 * per-frame entity↔sprite reconciliation.
 */

// --- Texture keys ---
const TEX_PLAYER = '__cw_player';
const TEX_ENEMY = '__cw_enemy';
const TEX_NPC = '__cw_npc';
const TEX_ENEMY_RAT = '__cw_enemy_rat';
const TEX_ENEMY_SLIME = '__cw_enemy_slime';
const TEX_ENEMY_BOSS = '__cw_enemy_boss';
const TEX_GEM = '__cw_gem';
const TEX_BULLET = '__cw_bullet';
const TEX_BOSS_CHEST = '__cw_boss_chest';
const TEX_ENEMY_BULLET = '__cw_enemy_bullet';
const TEX_AOE_PROJ = '__cw_aoe_proj';
const TEX_ENEMY_AOE_PROJ = '__cw_enemy_aoe_proj';
const TEX_RETURNING = '__cw_returning';
const TEX_MELEE = '__cw_melee';
const TEX_TRAP_ARMED = '__cw_trap_armed';
const TEX_TRAP_ARMING = '__cw_trap_arming';
const TEX_EXPLOSION = '__cw_explosion';
const TEX_ENEMY_EXPLOSION = '__cw_enemy_explosion';
const TEX_DEAD_SKULL = '__cw_dead_skull';
export const TEX_WELCOME_SIGN = '__cw_welcome_sign';
export const TEX_WELCOME_SIGN_LEFT = '__cw_welcome_sign_left';
const TEX_GOLD = '__cw_gold';
export const PROCEDURAL_TEXTURE_KEYS = {
  default: TEX_BULLET,
  player: TEX_PLAYER,
  enemy: TEX_ENEMY,
  npc: TEX_NPC,
  enemy_rat: TEX_ENEMY_RAT,
  enemy_slime: TEX_ENEMY_SLIME,
  enemy_boss: TEX_ENEMY_BOSS,
  gem: TEX_GEM,
  boss_chest: TEX_BOSS_CHEST,
  gold: TEX_GOLD,
  proj: TEX_BULLET,
  enemy_proj: TEX_ENEMY_BULLET,
  aoe_proj: TEX_AOE_PROJ,
  enemy_aoe_proj: TEX_ENEMY_AOE_PROJ,
  returning: TEX_RETURNING,
  melee: TEX_MELEE,
  trap_armed: TEX_TRAP_ARMED,
  trap_arming: TEX_TRAP_ARMING,
  explosion: TEX_EXPLOSION,
  enemy_explosion: TEX_ENEMY_EXPLOSION,
  dead_skull: TEX_DEAD_SKULL,
  welcome_sign: TEX_WELCOME_SIGN,
} as const;
export type ProceduralTextureToken = keyof typeof PROCEDURAL_TEXTURE_KEYS;
/** Native dimensions of the baked welcome-sign texture (board + word + arrow). */
const WELCOME_SIGN_WIDTH = 48;
const WELCOME_SIGN_HEIGHT = 26;
const logger = createLogger('engine:phaser-bridge');

export function generateTextures(scene: Phaser.Scene): void {
  // Skip texture generation when running in test mocks without a texture manager
  if (!scene.textures || !scene.add.graphics) {
    logger.debug('Skipping procedural texture generation; texture manager unavailable');
    return;
  }
  if (scene.textures.exists(TEX_PLAYER)) return;

  const g = scene.add.graphics();

  // Player — green diamond
  g.clear();
  g.fillStyle(0x00ff66, 1);
  g.fillTriangle(12, 0, 0, 12, 12, 24);
  g.fillTriangle(12, 0, 24, 12, 12, 24);
  g.lineStyle(2, 0x88ffaa, 0.6);
  g.strokeCircle(12, 12, 13);
  g.generateTexture(TEX_PLAYER, 26, 26);

  // Enemy — red circle with dark core
  g.clear();
  g.fillStyle(0xff2222, 1);
  g.fillCircle(10, 10, 10);
  g.fillStyle(0x880000, 0.5);
  g.fillCircle(10, 10, 5);
  g.generateTexture(TEX_ENEMY, 22, 22);

  // NPC (placeholder) — simple stick-figure silhouette.
  g.clear();
  g.lineStyle(2, 0xf1f5f9, 1);
  g.strokeCircle(8, 5, 3);
  g.beginPath();
  g.moveTo(8, 8);
  g.lineTo(8, 15);
  g.moveTo(3, 11);
  g.lineTo(13, 11);
  g.moveTo(8, 15);
  g.lineTo(4, 20);
  g.moveTo(8, 15);
  g.lineTo(12, 20);
  g.strokePath();
  g.generateTexture(TEX_NPC, 16, 22);

  // Rat — gray body with darker head/tail hint. Authored facing RIGHT to
  // match the sprite pipeline contract (`data/sprite-types/enemy.json`
  // enforces `sensors.enemy.facing: "right"` for enemy briefs) and the
  // flip logic in PhaserBridge which assumes right-facing native art:
  // head circle sits on the RIGHT half of the texture, tail whip on the
  // LEFT. If you flip the head/tail here, revisit the enemy flip block in
  // PhaserBridge.ts and the enemy sprite pipeline together.
  g.clear();
  g.fillStyle(0x8f959e, 1);
  g.fillEllipse(11, 12, 18, 12);
  g.fillStyle(0xb7bcc4, 1);
  g.fillCircle(18, 9, 4);
  g.lineStyle(2, 0x6f7782, 1);
  g.beginPath();
  g.moveTo(6, 13);
  g.lineTo(2, 15);
  g.strokePath();
  g.generateTexture(TEX_ENEMY_RAT, 24, 22);

  // Slime — green blob with glossy top and dark core
  g.clear();
  g.fillStyle(0x2cb34a, 1);
  g.fillCircle(11, 11, 10);
  g.fillStyle(0x5eea81, 0.85);
  g.fillCircle(8, 7, 4);
  g.fillStyle(0x157a2f, 0.5);
  g.fillCircle(11, 13, 5);
  g.generateTexture(TEX_ENEMY_SLIME, 22, 22);

  // Boss — rat/slime hybrid, large and unmistakable. The slime tail hangs
  // off the LEFT so the boss reads as facing RIGHT (matching the
  // right-facing sprite pipeline contract — see the rat block above).
  g.clear();
  g.fillStyle(0x1d4ed8, 0.18);
  g.fillEllipse(22, 22, 40, 34);
  g.fillStyle(0x22c55e, 1);
  g.fillEllipse(24, 24, 24, 18);
  g.fillStyle(0x8f959e, 1);
  g.fillCircle(14, 16, 7);
  g.fillCircle(34, 16, 7);
  g.fillStyle(0x2cb34a, 0.9);
  g.fillEllipse(26, 28, 30, 24);
  g.fillStyle(0xb7bcc4, 1);
  g.fillTriangle(10, 13, 14, 5, 18, 14);
  g.fillTriangle(30, 14, 34, 5, 38, 13);
  g.fillStyle(0x157a2f, 0.75);
  g.fillCircle(24, 26, 7);
  g.fillStyle(0x0f4c1d, 0.75);
  g.fillTriangle(14, 28, 4, 34, 10, 37);
  g.lineStyle(3, 0x6f7782, 1);
  g.beginPath();
  g.moveTo(16, 35);
  g.lineTo(10, 39);
  g.moveTo(36, 34);
  g.lineTo(44, 39);
  g.strokePath();
  g.fillStyle(0xf8fafc, 1);
  g.fillCircle(20, 23, 2);
  g.fillCircle(29, 23, 2);
  g.fillStyle(0x0b1020, 1);
  g.fillCircle(20, 23, 1);
  g.fillCircle(29, 23, 1);
  g.generateTexture(TEX_ENEMY_BOSS, 44, 40);

  // XP gem — faceted cyan crystal with dark outline + sparkle
  g.clear();
  g.fillStyle(0x0b3038, 1);
  g.fillTriangle(7, 0, 0, 7, 7, 14);
  g.fillTriangle(7, 0, 14, 7, 7, 14);
  g.fillStyle(0x1f9fb8, 1);
  g.fillTriangle(7, 2, 2, 7, 7, 12);
  g.fillTriangle(7, 2, 12, 7, 7, 12);
  g.fillStyle(0x4fd6e8, 1);
  g.fillTriangle(7, 2, 2, 7, 7, 7);
  g.fillStyle(0x9af0ff, 1);
  g.fillRect(5, 3, 2, 2);
  g.generateTexture(TEX_GEM, 14, 14);

  // Boss chest — warm wood body with metal bands and a bright latch.
  g.clear();
  g.fillStyle(0x3b2414, 1);
  g.fillRoundedRect(4, 12, 28, 16, 4);
  g.fillStyle(0x6b3f1f, 1);
  g.fillRoundedRect(4, 8, 28, 10, 4);
  g.fillStyle(0xb88b4a, 1);
  g.fillRect(7, 14, 22, 3);
  g.fillRect(7, 21, 22, 3);
  g.fillRect(16, 12, 4, 16);
  g.fillStyle(0xffd76a, 1);
  g.fillRoundedRect(15, 17, 6, 5, 2);
  g.lineStyle(2, 0xe7c98a, 0.85);
  g.strokeRect(4, 8, 28, 20);
  g.generateTexture(TEX_BOSS_CHEST, 36, 32);

  // Player bullet — white elongated pill
  g.clear();
  g.fillStyle(0xffffff, 1);
  g.fillRoundedRect(0, 0, 4, 10, 2);
  g.generateTexture(TEX_BULLET, 4, 10);

  // Enemy bullet — orange pill
  g.clear();
  g.fillStyle(0xff8800, 1);
  g.fillRoundedRect(0, 0, 4, 10, 2);
  g.generateTexture(TEX_ENEMY_BULLET, 4, 10);

  // AoE projectile (fireball) — orange-red glow
  g.clear();
  g.fillStyle(0xff4400, 0.4);
  g.fillCircle(10, 10, 10);
  g.fillStyle(0xff6600, 1);
  g.fillCircle(10, 10, 5);
  g.fillStyle(0xffcc00, 0.8);
  g.fillCircle(10, 10, 3);
  g.generateTexture(TEX_AOE_PROJ, 22, 22);

  // Enemy AoE projectile (acid ball) — green glow
  g.clear();
  g.fillStyle(0x10b981, 0.4);
  g.fillCircle(10, 10, 10);
  g.fillStyle(0x22c55e, 1);
  g.fillCircle(10, 10, 5);
  g.fillStyle(0xbbf7d0, 0.8);
  g.fillCircle(10, 10, 3);
  g.generateTexture(TEX_ENEMY_AOE_PROJ, 22, 22);

  // Returning weapon — cyan spinning square shape
  g.clear();
  g.fillStyle(0x44ddff, 1);
  g.fillTriangle(8, 0, 16, 8, 8, 16);
  g.fillTriangle(8, 0, 0, 8, 8, 16);
  g.generateTexture(TEX_RETURNING, 18, 18);

  // Melee AoE — semi-transparent white arc ring
  g.clear();
  g.fillStyle(0xffffaa, 0.25);
  g.fillCircle(32, 32, 32);
  g.lineStyle(2, 0xffffaa, 0.6);
  g.strokeCircle(32, 32, 32);
  g.generateTexture(TEX_MELEE, 66, 66);

  // Trap (arming) — dim red square with border
  g.clear();
  g.fillStyle(0xff0000, 0.25);
  g.fillRect(0, 0, 14, 14);
  g.lineStyle(2, 0xff0000, 0.6);
  g.strokeRect(1, 1, 12, 12);
  g.generateTexture(TEX_TRAP_ARMING, 14, 14);

  // Trap (armed) — bright red square
  g.clear();
  g.fillStyle(0xff0000, 0.5);
  g.fillRect(0, 0, 14, 14);
  g.lineStyle(2, 0xff4444, 1.0);
  g.strokeRect(1, 1, 12, 12);
  g.fillStyle(0xff6666, 0.8);
  g.fillCircle(7, 7, 3);
  g.generateTexture(TEX_TRAP_ARMED, 14, 14);

  // Explosion ring — orange-red filled circle
  g.clear();
  g.fillStyle(0xff4400, 0.3);
  g.fillCircle(32, 32, 32);
  g.lineStyle(3, 0xff6600, 0.7);
  g.strokeCircle(32, 32, 32);
  g.fillStyle(0xffaa00, 0.2);
  g.fillCircle(32, 32, 20);
  g.generateTexture(TEX_EXPLOSION, 66, 66);

  // Enemy acid explosion — green splash
  g.clear();
  g.fillStyle(0x22c55e, 0.32);
  g.fillCircle(32, 32, 32);
  g.lineStyle(3, 0x16a34a, 0.72);
  g.strokeCircle(32, 32, 32);
  g.fillStyle(0xbbf7d0, 0.24);
  g.fillCircle(32, 32, 20);
  g.generateTexture(TEX_ENEMY_EXPLOSION, 66, 66);

  // Dead marker — simple skull icon for corpse linger window
  g.clear();
  g.fillStyle(0xf8fafc, 0.95);
  g.fillCircle(8, 7, 5);
  g.fillRect(4, 9, 8, 5);
  g.fillRect(6, 14, 1, 2);
  g.fillRect(8, 14, 1, 2);
  g.fillRect(10, 14, 1, 2);
  g.fillStyle(0x0b1020, 1);
  g.fillCircle(6, 6, 1);
  g.fillCircle(10, 6, 1);
  g.fillRect(7, 9, 2, 1);
  g.generateTexture(TEX_DEAD_SKULL, 16, 16);

  // Welcome sign — a wooden board with the word "WELCOME" and a direction arrow
  // baked into a single canvas texture so the word is PART of the sign. Two
  // variants are baked: the arrow points right in one and left in the other,
  // with "WELCOME" upright in both. The renderer uses the left variant (rotating
  // from the −x reference) once a sign points past vertical, so the word always
  // reads upright instead of flipping over when the sign rotates leftward.
  const w = WELCOME_SIGN_WIDTH;
  const h = WELCOME_SIGN_HEIGHT;
  const drawSignArrow = (
    pen: { moveTo: (x: number, y: number) => void; lineTo: (x: number, y: number) => void },
    dir: 'left' | 'right',
  ): void => {
    if (dir === 'right') {
      pen.moveTo(8, 18);
      pen.lineTo(w - 9, 18);
      pen.moveTo(w - 15, 13);
      pen.lineTo(w - 9, 18);
      pen.lineTo(w - 15, 23);
    } else {
      pen.moveTo(w - 8, 18);
      pen.lineTo(9, 18);
      pen.moveTo(15, 13);
      pen.lineTo(9, 18);
      pen.lineTo(15, 23);
    }
  };
  const bakeSignTexture = (key: string, dir: 'left' | 'right'): void => {
    const signCanvas =
      typeof scene.textures.createCanvas === 'function'
        ? scene.textures.createCanvas(key, w, h)
        : null;
    const signCtx = signCanvas?.context ?? null;
    if (signCtx) {
      // Wooden board with a darker border.
      signCtx.fillStyle = '#8b5a2b';
      signCtx.fillRect(0, 0, w, h);
      signCtx.strokeStyle = '#5c3a21';
      signCtx.lineWidth = 2;
      signCtx.strokeRect(1, 1, w - 2, h - 2);
      // "WELCOME" painted across the top half.
      signCtx.fillStyle = '#ffe9a8';
      signCtx.strokeStyle = '#3a2410';
      signCtx.lineWidth = 2;
      signCtx.font = 'bold 9px monospace';
      signCtx.textAlign = 'center';
      signCtx.textBaseline = 'middle';
      signCtx.strokeText('WELCOME', w / 2, 8);
      signCtx.fillText('WELCOME', w / 2, 8);
      // Arrow across the bottom half.
      signCtx.strokeStyle = '#ffffff';
      signCtx.lineWidth = 3;
      signCtx.lineCap = 'round';
      signCtx.lineJoin = 'round';
      signCtx.beginPath();
      drawSignArrow(signCtx, dir);
      signCtx.stroke();
      signCanvas?.refresh();
      return;
    }
    // Fallback for renderers without canvas textures: board + arrow via graphics
    // (no baked word, but the sign still exists and points the right way).
    g.clear();
    g.fillStyle(0x8b5a2b, 1);
    g.fillRect(0, 0, w, h);
    g.lineStyle(2, 0x5c3a21, 1);
    g.strokeRect(1, 1, w - 2, h - 2);
    g.lineStyle(3, 0xffffff, 0.9);
    g.beginPath();
    drawSignArrow(g, dir);
    g.strokePath();
    g.generateTexture(key, w, h);
  };
  bakeSignTexture(TEX_WELCOME_SIGN, 'right');
  bakeSignTexture(TEX_WELCOME_SIGN_LEFT, 'left');

  // Gold coin — round yellow disc with dark outline and a lighter highlight.
  g.clear();
  g.fillStyle(0x6b4a08, 1);
  g.fillCircle(8, 8, 8);
  g.fillStyle(0xffd24a, 1);
  g.fillCircle(8, 8, 6);
  g.fillStyle(0xd79320, 1);
  g.fillCircle(9, 9, 3);
  g.fillStyle(0xfff4c2, 1);
  g.fillRect(5, 4, 2, 2);
  g.generateTexture(TEX_GOLD, 16, 16);

  g.destroy();
  logger.info('Generated procedural fallback textures');
}
