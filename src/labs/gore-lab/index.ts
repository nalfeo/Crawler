import { registerLab, type LabCategory } from '../registry.js';
import { SeededRandom } from '../../shared/random.js';

interface GoreLabSettings {
  hitGoreEnabled: boolean;
  intensity: number;
  overkillAmount: number;
  hitDamage: number;
  goreFactor: number;
}

const DEFAULT_SETTINGS: GoreLabSettings = {
  hitGoreEnabled: true,
  intensity: 1.0,
  overkillAmount: 10,
  hitDamage: 15,
  goreFactor: 0.8,
};

interface LabGuiController {
  name(label: string): LabGuiController;
  onChange?(handler: () => void): LabGuiController;
  updateDisplay?(): void;
}

interface LabGuiLike {
  add(...args: unknown[]): LabGuiController;
  addFolder?(title: string): LabGuiLike;
  open?(): void;
  destroy?(): void;
}

type ControlsWithGui = HTMLElement & { __labGui?: LabGuiLike };

function createGoreLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const settings: GoreLabSettings = { ...DEFAULT_SETTINGS };

  const root = document.createElement('div');
  root.style.padding = '24px';
  root.style.color = '#f8fafc';
  root.style.fontFamily = 'Inter, system-ui, sans-serif';

  const title = document.createElement('h2');
  title.textContent = 'Gore VFX Lab';
  title.style.marginBottom = '8px';

  const description = document.createElement('p');
  description.textContent =
    'Use the buttons below to simulate hit-gore and death-gore events. Adjust intensity and parameters with controls.';
  description.style.color = '#cbd5e1';
  description.style.marginBottom = '16px';

  // Phaser-lite canvas for particles
  const info = document.createElement('p');
  info.textContent =
    'Note: This lab requires Phaser scene context. Below is a preview of the config and event simulation. Full visual preview available in-game.';
  info.style.color = '#94a3b8';
  info.style.fontSize = '13px';
  info.style.marginBottom = '16px';

  const eventLog = document.createElement('pre');
  eventLog.style.background = 'rgba(15, 23, 42, 0.9)';
  eventLog.style.border = '1px solid rgba(148, 163, 184, 0.2)';
  eventLog.style.borderRadius = '12px';
  eventLog.style.padding = '16px';
  eventLog.style.fontSize = '13px';
  eventLog.style.lineHeight = '1.6';
  eventLog.style.minHeight = '200px';
  eventLog.style.whiteSpace = 'pre-wrap';
  eventLog.textContent = 'Click buttons below to simulate gore events.';

  const logs: string[] = [];

  function log(msg: string): void {
    logs.push(msg);
    if (logs.length > 30) logs.shift();
    eventLog.textContent = logs.join('\n');
  }

  const hitButton = document.createElement('button');
  hitButton.textContent = 'Simulate Hit Gore';
  hitButton.style.cssText =
    'padding: 10px 20px; border: 1px solid rgba(148,163,184,0.25); border-radius: 12px; background: rgba(30,41,59,0.96); color: #f8fafc; font-size: 14px; font-weight: 600; cursor: pointer; margin-right: 12px; margin-bottom: 16px;';

  hitButton.addEventListener('click', () => {
    const labRng = new SeededRandom(Date.now());
    const event = {
      type: 'hit' as const,
      x: 200 + labRng.next() * 200,
      y: 200 + labRng.next() * 100,
      amount: settings.hitDamage,
      targetType: 'enemy' as const,
      timestamp: performance.now(),
      weaponGoreFactor: settings.goreFactor,
    };
    log(
      `HIT @ (${event.x.toFixed(0)}, ${event.y.toFixed(0)}) dmg=${event.amount} goreFactor=${event.weaponGoreFactor}`,
    );
  });

  const deathButton = document.createElement('button');
  deathButton.textContent = 'Simulate Death Gore';
  deathButton.style.cssText = hitButton.style.cssText;

  deathButton.addEventListener('click', () => {
    const labRng = new SeededRandom(Date.now());
    const angle = labRng.next() * Math.PI * 2;
    const event = {
      type: 'death' as const,
      x: 200 + labRng.next() * 200,
      y: 200 + labRng.next() * 100,
      amount: 50,
      targetType: 'enemy' as const,
      timestamp: performance.now(),
      overkill: settings.overkillAmount,
      knockbackDirX: Math.cos(angle),
      knockbackDirY: Math.sin(angle),
    };
    const overkillMult = 1 + Math.min(event.overkill / 20, 3);
    const particleCount = Math.round(12 * overkillMult * settings.intensity);
    log(
      `DEATH @ (${event.x.toFixed(0)}, ${event.y.toFixed(0)}) overkill=${event.overkill} → ${particleCount} particles`,
    );
  });

  root.append(title, description, info, hitButton, deathButton, eventLog);
  canvasHost.append(root);

  // GUI controls
  const guiGroup = typeof gui.addFolder === 'function' ? gui.addFolder('Gore Lab') : gui;
  guiGroup.add(settings, 'hitGoreEnabled').name('Hit Gore');
  guiGroup.add(settings, 'intensity', 0, 3, 0.1).name('Intensity');
  guiGroup.add(settings, 'overkillAmount', 0, 100, 1).name('Overkill Amount');
  guiGroup.add(settings, 'hitDamage', 1, 50, 1).name('Hit Damage');
  guiGroup.add(settings, 'goreFactor', 0, 1, 0.05).name('Gore Factor');
  guiGroup.open?.();

  return () => {
    if (guiGroup !== gui) guiGroup.destroy?.();
    root.remove();
  };
}

registerLab('gore-lab', {
  category: 'Combat' as LabCategory,
  name: 'Gore Lab',
  description: 'Preview and tune blood splatter particle effects on hit and death.',
  create: createGoreLab,
});
