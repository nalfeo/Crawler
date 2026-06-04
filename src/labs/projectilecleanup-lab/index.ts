import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createProjectileCleanupLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.height = '100%';
  root.style.padding = '24px';
  root.style.background = 'radial-gradient(circle at top, #4a321f 0%, #2b1e12 60%, #1a120b 100%)';

  const card = document.createElement('div');
  card.style.maxWidth = '640px';
  card.style.padding = '20px';
  card.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  card.style.borderRadius = '14px';
  card.style.background = 'rgba(30, 20, 12, 0.85)';
  card.style.color = '#fed7aa';
  card.style.lineHeight = '1.6';
  card.textContent =
    'Projectile Cleanup Lab placeholder. Use this lab to validate projectile lifetime and bounds cleanup behavior.';

  root.append(card);
  canvasHost.append(root);

  return () => {
    root.remove();
  };
}

registerLab('projectilecleanup-lab', {
  name: 'Projectile Cleanup Lab',
  description: 'Sandbox for projectile cleanup system behavior.',
  create: createProjectileCleanupLab,
});

