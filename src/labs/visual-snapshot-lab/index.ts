import Phaser from 'phaser';
import { registerLab } from '../registry.js';
import { SeededRandom } from '../../shared/random.js';

const LAB_ID = 'visual-snapshot-lab';

const TILE = 64;
const GW = 11; // grid width (tiles)
const GH = 9; // grid height (tiles)
const FLOOR_VARIANTS = 2; // 0 = flat, 1 = lightly speckled
const DOOR_OPEN_COL = 5; // top wall
const DOOR_CLOSED_ROW = 4; // right wall

class VisualSnapshotScene extends Phaser.Scene {
  constructor() {
    super('VisualSnapshotScene');
  }

  preload() {
    for (let i = 0; i < FLOOR_VARIANTS; i++) {
      this.load.image(`floor_${i}`, `assets/generated/temp_floor_${i}.png`);
    }
    this.load.image('wall', 'assets/generated/temp_wall.png');
    this.load.image('door_closed', 'assets/generated/temp_door_closed.png');
    this.load.image('door_open', 'assets/generated/temp_door_open.png');
    this.load.image('hero', 'assets/generated/temp_hero.png');
    this.load.image('npc', 'assets/generated/temp_npc.png');
    this.load.image('slime', 'assets/generated/temp_slime.png');
    this.load.image('rat', 'assets/generated/temp_rat.png');
    this.load.image('fireball', 'assets/generated/temp_fireball.png');
  }

  private tile(col: number, row: number, key: string, depth: number): Phaser.GameObjects.Image {
    const img = this.add.image(col * TILE, row * TILE, key);
    img.setOrigin(0, 0);
    img.setDepth(depth);
    return img;
  }

  private entity(col: number, row: number, key: string): Phaser.GameObjects.Image {
    const x = col * TILE + TILE / 2;
    const y = row * TILE + TILE / 2;
    const img = this.add.image(x, y, key);
    img.setOrigin(0.5, 0.9); // feet near tile centre for grounded look
    img.setDepth(1000 + y);
    return img;
  }

  create() {
    this.cameras.main.setBackgroundColor('#0e0b14');
    const rng = new SeededRandom(0xc0ffee);

    const isWall = (c: number, r: number) => c === 0 || r === 0 || c === GW - 1 || r === GH - 1;
    // Mostly the flat tile; sprinkle the speckled one so it varies without seams.
    const floorKey = () => `floor_${rng.nextInt(0, 3) === 0 ? 1 : 0}`;

    // 1. Floor everywhere (under walls + doorways too -> never a black gap).
    //    Plus a passage tile just outside the open door.
    this.tile(DOOR_OPEN_COL, -1, floorKey(), 0);
    for (let r = 0; r < GH; r++) {
      for (let c = 0; c < GW; c++) {
        this.tile(c, r, floorKey(), 0);
      }
    }

    // 1b. Scatter subtle floor detail (pebbles / cracks) so the floor reads as
    //     textured and varied rather than a repeated tile.
    for (let n = 0; n < 14; n++) {
      const c = rng.nextInt(1, GW - 2);
      const r = rng.nextInt(1, GH - 2);
      const px = c * TILE + rng.nextInt(10, TILE - 10);
      const py = r * TILE + rng.nextInt(10, TILE - 10);
      const dark = rng.nextInt(0, 1) === 0;
      const spec = this.add.ellipse(
        px,
        py,
        rng.nextInt(4, 9),
        rng.nextInt(4, 8),
        dark ? 0x8f7048 : 0xe2c79a,
        dark ? 0.5 : 0.4,
      );
      spec.setDepth(2);
    }

    // 2. Uniform wall ring (single cohesive grey-brick block, no corner logic).
    for (let r = 0; r < GH; r++) {
      for (let c = 0; c < GW; c++) {
        if (!isWall(c, r)) continue;
        if (r === 0 && c === DOOR_OPEN_COL) continue; // open doorway
        if (c === GW - 1 && r === DOOR_CLOSED_ROW) continue; // closed doorway
        this.tile(c, r, 'wall', 1);
      }
    }

    // 3. Doors. Open door sits over floor threshold so the passage shows through.
    this.tile(DOOR_OPEN_COL, 0, 'door_open', 2);
    this.tile(GW - 1, DOOR_CLOSED_ROW, 'door_closed', 2);

    // 3b. Inner drop-shadow cast from the wall ring onto the floor -> the walls
    //     read as taller than the floor (depth), not a flat painted band.
    const inX = TILE;
    const inY = TILE;
    const inW = (GW - 2) * TILE;
    const inH = (GH - 2) * TILE;
    const shadow = (x: number, y: number, w: number, h: number, a: number) => {
      const s = this.add.rectangle(x, y, w, h, 0x000000, a);
      s.setOrigin(0, 0);
      s.setDepth(3);
      s.setBlendMode(Phaser.BlendModes.MULTIPLY);
    };
    for (let layer = 0; layer < 3; layer++) {
      const t = (3 - layer) * 5; // 15,10,5 px thick
      const a = 0.18 - layer * 0.05;
      shadow(inX, inY + layer * 5, inW, t, a); // top
      shadow(inX, inY + inH - (layer + 1) * 5, inW, t, a); // bottom
      shadow(inX + layer * 5, inY, t, inH, a); // left
      shadow(inX + inW - (layer + 1) * 5, inY, t, inH, a); // right
    }

    // 4. Entities on interior floor.
    this.entity(3, 2, 'npc');
    this.entity(7, 3, 'hero');
    this.entity(3, 6, 'slime');
    this.entity(7, 6, 'rat');

    // 5. Animated fireball in flight: trailing tail + layered glow + flicker.
    const fy = 4 * TILE + TILE / 2;
    const x0 = 3 * TILE;
    const x1 = 8 * TILE;

    const tail = this.add.ellipse(x0, fy, 150, 34, 0xff5a1e, 0.3);
    tail.setBlendMode(Phaser.BlendModes.ADD);
    tail.setDepth(3999);
    const glow = this.add.ellipse(x0, fy, 104, 104, 0xff7a22, 0.5);
    glow.setBlendMode(Phaser.BlendModes.ADD);
    glow.setDepth(4000);
    const core = this.add.ellipse(x0, fy, 46, 46, 0xffd24a, 0.75);
    core.setBlendMode(Phaser.BlendModes.ADD);
    core.setDepth(4001);
    const fire = this.add.image(x0, fy, 'fireball');
    fire.setOrigin(0.5, 0.5);
    fire.setScale(1.15);
    fire.setDepth(4002);

    const travelers = [tail, glow, core, fire];
    this.tweens.add({
      targets: travelers,
      x: x1,
      duration: 1400,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
      onYoyo: () => {
        tail.scaleX = -1; // tail trails behind direction of travel
      },
      onRepeat: () => {
        tail.scaleX = 1;
      },
    });
    this.tweens.add({
      targets: [glow, core],
      scale: 1.3,
      duration: 240,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });
    this.tweens.add({
      targets: fire,
      scaleX: 1.3,
      scaleY: 1.0,
      angle: 12,
      duration: 130,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });

    // Frame the room.
    this.cameras.main.setZoom(1.2);
    this.cameras.main.centerOn((GW * TILE) / 2, (GH * TILE) / 2);
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
