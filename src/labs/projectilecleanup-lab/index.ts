import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createProjectileCleanupLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const params = { boundsPadding: 32, sampleProjectiles: 150, sampleFrames: 240 };
  gui.add(params, 'boundsPadding', 0, 256, 1).name('Padding');
  gui.add(params, 'sampleProjectiles', 10, 500, 1).name('Projectiles');
  gui.add(params, 'sampleFrames', 30, 600, 10).name('Frames');

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;line-height:1.6;';
  panel.textContent =
    'Projectile Cleanup Lab scaffold.\nUse this sandbox to verify off-screen/despawn cleanup behavior.';
  canvasHost.append(panel);

  const hint = document.createElement('p');
  hint.textContent =
    'Stub lab for projectileCleanupSystem. Add projectile lifetime histograms and despawn reason counters.';
  hint.style.cssText = 'padding:8px 16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('projectilecleanup-lab', {
  category: 'Entities' as LabCategory,
  name: 'Projectile Cleanup Lab',
  description: 'Scaffold for validating projectileCleanupSystem behavior.',
  create: createProjectileCleanupLab,
});
