import Phaser from 'phaser';
import { registerLab } from '../registry.js';

const LAB_ID = 'visual-snapshot-lab';

class VisualSnapshotScene extends Phaser.Scene {
  constructor() {
    super('VisualSnapshotScene');
  }

  preload() {
    for (let i = 0; i < 16; i++) {
      this.load.image(`floor_${i}`, `assets/generated/temp_floor_${i}.png`);
    }
    for (let i = 0; i < 4; i++) {
      this.load.image(`wall_h_${i}`, `assets/generated/temp_wall_h_${i}.png`);
      this.load.image(`wall_v_${i}`, `assets/generated/temp_wall_v_${i}.png`);
    }
    this.load.image('wall_tl', 'assets/generated/temp_wall_tl.png');
    this.load.image('wall_tr', 'assets/generated/temp_wall_tr.png');
    this.load.image('wall_bl', 'assets/generated/temp_wall_bl.png');
    this.load.image('wall_br', 'assets/generated/temp_wall_br.png');
    this.load.image('door_closed', 'assets/generated/temp_door_closed.png');
    this.load.image('door_open', 'assets/generated/temp_door_open.png');
    this.load.image('hero', 'assets/generated/temp_hero.png');
    this.load.image('slime', 'assets/generated/temp_slime.png');
    this.load.image('rat', 'assets/generated/temp_rat.png');
    this.load.image('fireball', 'assets/generated/temp_fireball.png');
  }

  create() {
    this.cameras.main.setBackgroundColor('#16131d');

    const tileSize = 64;

    // Draw 10x10 floor
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const variant = Math.floor(Math.random() * 16);
        const img = this.add.image(
          x * tileSize + tileSize / 2,
          y * tileSize + tileSize / 2,
          `floor_${variant}`,
        );
        img.setOrigin(0.5, 0.5);
      }
    }

    // Top wall
    for (let x = 2; x < 8; x++) {
      const img = this.add.image(
        x * tileSize + tileSize / 2,
        2 * tileSize + tileSize,
        `wall_h_${Math.floor(Math.random() * 4)}`,
      );
      img.setOrigin(0.5, 0.5);
      img.setDepth(2 * tileSize + tileSize);
    }

    // Left and right walls
    for (let y = 3; y < 7; y++) {
      const img1 = this.add.image(
        2 * tileSize + tileSize / 2,
        y * tileSize + tileSize,
        `wall_v_${Math.floor(Math.random() * 4)}`,
      );
      img1.setOrigin(0.5, 0.5);
      img1.setDepth(y * tileSize + tileSize);

      const img2 = this.add.image(
        7 * tileSize + tileSize / 2,
        y * tileSize + tileSize,
        `wall_v_${Math.floor(Math.random() * 4)}`,
      );
      img2.setOrigin(0.5, 0.5);
      img2.setDepth(y * tileSize + tileSize);
    }

    // Corners
    const tl = this.add.image(2 * tileSize + tileSize / 2, 2 * tileSize + tileSize, 'wall_tl');
    tl.setOrigin(0.5, 0.5);
    tl.setDepth(2 * tileSize + tileSize);
    const tr = this.add.image(7 * tileSize + tileSize / 2, 2 * tileSize + tileSize, 'wall_tr');
    tr.setOrigin(0.5, 0.5);
    tr.setDepth(2 * tileSize + tileSize);
    const bl = this.add.image(2 * tileSize + tileSize / 2, 7 * tileSize + tileSize, 'wall_bl');
    bl.setOrigin(0.5, 0.5);
    bl.setDepth(7 * tileSize + tileSize);
    const br = this.add.image(7 * tileSize + tileSize / 2, 7 * tileSize + tileSize, 'wall_br');
    br.setOrigin(0.5, 0.5);
    br.setDepth(7 * tileSize + tileSize);

    // Doors
    const d1 = this.add.image(5 * tileSize + tileSize / 2, 2 * tileSize + tileSize, 'door_open');
    d1.setOrigin(0.5, 0.5);
    d1.setDepth(2 * tileSize + tileSize);
    const d2 = this.add.image(7 * tileSize + tileSize / 2, 5 * tileSize + tileSize, 'door_closed');
    d2.setOrigin(0.5, 0.5);
    d2.setDepth(5 * tileSize + tileSize);

    // Sprites
    const hero = this.add.image(4 * tileSize + tileSize / 2, 4 * tileSize + tileSize / 2, 'hero');
    hero.setOrigin(0.5, 0.5);
    hero.setDepth(hero.y);
    const slime = this.add.image(3 * tileSize + tileSize / 2, 5 * tileSize + tileSize / 2, 'slime');
    slime.setOrigin(0.5, 0.5);
    slime.setDepth(slime.y);
    const rat = this.add.image(6 * tileSize + tileSize / 2, 6 * tileSize + tileSize / 2, 'rat');
    rat.setOrigin(0.5, 0.5);
    rat.setDepth(rat.y);
    const fire = this.add.image(5 * tileSize, 4 * tileSize + tileSize / 2, 'fireball');
    fire.setOrigin(0.5, 0.5);
    fire.setDepth(fire.y);

    // Zoom in a bit
    this.cameras.main.setZoom(2);
    this.cameras.main.centerOn(5 * tileSize, 5 * tileSize);
  }
}

registerLab(LAB_ID, {
  name: 'Visual Snapshot',
  description: 'Shows core floor 1 elements for automated evaluation.',
  category: 'Meta',
  create: (canvas) => {
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: canvas,
      width: 1280,
      height: 720,
      scene: VisualSnapshotScene,
      pixelArt: true,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });
    return () => game.destroy(true);
  },
});
