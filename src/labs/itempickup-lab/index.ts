import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createItemPickupLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.height = '100%';
  root.style.padding = '24px';
  root.style.background = 'radial-gradient(circle at top, #1f3f4f 0%, #122631 60%, #0b141c 100%)';

  const card = document.createElement('div');
  card.style.maxWidth = '640px';
  card.style.padding = '20px';
  card.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  card.style.borderRadius = '14px';
  card.style.background = 'rgba(9, 22, 30, 0.85)';
  card.style.color = '#dbeafe';
  card.style.lineHeight = '1.6';
  card.textContent =
    'Item Pickup Lab placeholder. Use this lab to iterate on collision-driven auto-pickup and inventory integration.';

  root.append(card);
  canvasHost.append(root);

  return () => {
    root.remove();
  };
}

registerLab('itempickup-lab', {
  name: 'Item Pickup Lab',
  description: 'Sandbox for item pickup system behavior.',
  create: createItemPickupLab,
});

