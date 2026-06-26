/**
 * Render Scale Lab — visual sandbox for the HiDPI supersampling render scale.
 *
 * The shipped game renders the 1280×720 design space into a `design × S`
 * framebuffer (S = integer render scale) and zooms the UI camera by S so text
 * and pixel art stay crisp on high-density displays (see
 * src/engine/render-scale.ts). This lab makes the effect visible: it renders the
 * same block of HUD-style text into a framebuffer sized `design × S` (mirroring
 * the real UI camera with `setOrigin(0, 0) + setZoom(S)`), and a lil-gui toggle
 * flips S between 1 (the old blurry baseline) and 2 (supersampled). On a HiDPI
 * display the difference is obvious — S=1 text is soft, S=2 text is sharp.
 *
 * A readout reports the device pixel ratio, the host's CSS size, the render scale
 * that would be auto-detected at boot for this display, and the live framebuffer
 * (backing store) size.
 *
 * Labs layer — unrestricted imports.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME } from '../../shared/constants.js';
import {
  computeRenderScale,
  MAX_RENDER_SCALE,
  readDevicePixelRatio,
} from '../../engine/render-scale.js';
import { registerLab } from '../registry.js';

const LAB_ID = 'render-scale-lab';
const SCENE_KEY = 'RenderScaleLabScene';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface RenderScaleLabSettings {
  /** Forced render scale (framebuffer = design × renderScale). */
  renderScale: number;
}

/** Sample HUD-style strings rendered in design space to judge crispness. */
const SAMPLE_BODY =
  'Rhea Vale · Floor 1 is paused until you confirm a starter weapon.\n' +
  'Base bonuses: HP +20, Move +0.2, Pickup +8. Pick the weapon you want to begin with.';

function buildScene(getScale: () => number): typeof Phaser.Scene {
  return class RenderScaleLabScene extends Phaser.Scene {
    constructor() {
      super(SCENE_KEY);
    }

    create(): void {
      const renderScale = getScale();

      // Mirror the shipped UI camera: scale the 1280×720 design space up to fill
      // the design×S framebuffer with a top-left pivot so design (x, y) maps to
      // framebuffer (x×S, y×S).
      const cam = this.cameras.main;
      cam.setOrigin(0, 0);
      cam.setZoom(renderScale);
      cam.setScroll(0, 0);
      cam.roundPixels = true;
      cam.setBackgroundColor('#0b1020');

      // Text resolution tracks the render scale, exactly like getTextResolution.
      const resolution = renderScale;

      const heading = this.add.text(48, 44, 'Choose your opening loadout', {
        fontFamily: 'monospace',
        fontSize: '30px',
        color: '#ffd479',
        fontStyle: 'bold',
      });
      heading.setResolution(resolution);

      const timer = this.add.text(48, 96, 'Floor 1     6:00', {
        fontFamily: 'monospace',
        fontSize: '22px',
        color: '#e8eefc',
      });
      timer.setResolution(resolution);

      const body = this.add.text(48, 140, SAMPLE_BODY, {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#c7d2fe',
        lineSpacing: 4,
      });
      body.setResolution(resolution);

      // A row of small numeric labels — small glyphs reveal blur fastest.
      const small = ['120 / 120', 'x 0', 'LV 1', 'XP 0%', '6:00'];
      small.forEach((label, i) => {
        this.add
          .text(48 + i * 220, 230, label, {
            fontFamily: 'monospace',
            fontSize: '14px',
            color: '#9fb3d1',
          })
          .setResolution(resolution);
      });

      this.add
        .text(
          48,
          280,
          `RENDER SCALE S = ${renderScale}  (framebuffer ${GAME.WIDTH * renderScale}×${GAME.HEIGHT * renderScale})`,
          {
            fontFamily: 'monospace',
            fontSize: '18px',
            color: renderScale > 1 ? '#86efac' : '#fca5a5',
          },
        )
        .setResolution(resolution);

      // Live display diagnostics.
      const dpr = readDevicePixelRatio();
      const hostW = Math.round(this.scale.displaySize.width || this.scale.width);
      const hostH = Math.round(this.scale.displaySize.height || this.scale.height);
      const autoScale = computeRenderScale(hostW, hostH, dpr);
      const backing = `${this.scale.width}×${this.scale.height}`;
      const diagnostics =
        `devicePixelRatio: ${dpr}\n` +
        `host CSS size: ${hostW}×${hostH}\n` +
        `auto-detected boot scale: ${autoScale} (max ${MAX_RENDER_SCALE})\n` +
        `backing store: ${backing}`;
      this.add
        .text(48, 340, diagnostics, {
          fontFamily: 'monospace',
          fontSize: '14px',
          color: '#7c8aa5',
          lineSpacing: 4,
        })
        .setResolution(resolution);

      this.add
        .text(
          48,
          460,
          'Toggle "Render scale" in the panel → compare crispness (S=1 soft, S=2 sharp on HiDPI).',
          {
            fontFamily: 'monospace',
            fontSize: '13px',
            color: '#64748b',
          },
        )
        .setResolution(resolution);
    }
  };
}

function createRenderScaleLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: RenderScaleLabSettings = {
    renderScale: Math.min(2, MAX_RENDER_SCALE),
  };

  let game: Phaser.Game | undefined;

  const createGame = (): void => {
    game?.destroy(true);
    const scale = settings.renderScale;
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: canvasHost,
      width: GAME.WIDTH * scale,
      height: GAME.HEIGHT * scale,
      backgroundColor: '#0b1020',
      pixelArt: true,
      roundPixels: true,
      scene: [buildScene(() => settings.renderScale)],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    };
    game = new Phaser.Game(config);
  };

  gui
    .add(settings, 'renderScale', { '1× (baseline, blurry)': 1, '2× (supersampled, crisp)': 2 })
    .name('Render scale')
    .onChange(() => createGame());

  createGame();

  return () => {
    game?.destroy(true);
    game = undefined;
  };
}

registerLab(LAB_ID, {
  name: 'Render Scale',
  description:
    'HiDPI supersampling: render the design space into a design×S framebuffer for crisp text.',
  category: 'Meta',
  create: createRenderScaleLab,
});
