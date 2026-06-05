import GUI from 'lil-gui';
import {
  getGlobalControlsConfig,
  setGlobalControlsConfig,
  type MobileMoveMode,
} from '../engine/controls-config.js';
import { getLab } from './registry.js';

type CleanupFn = () => void;
type ControlsWithGui = HTMLElement & { __labGui?: GUI };

let activeCleanup: CleanupFn | undefined;
let activeGui: GUI | undefined;

function getLabElements(): { canvas: HTMLElement; controls: ControlsWithGui } {
  const canvas = document.getElementById('lab-canvas');
  const controls = document.getElementById('lab-controls') as ControlsWithGui | null;

  if (!canvas || !controls) {
    throw new Error('Lab page containers are missing.');
  }

  return { canvas, controls };
}

function destroyActiveLab(): void {
  try {
    activeCleanup?.();
  } finally {
    activeCleanup = undefined;
  }

  activeGui?.destroy();
  activeGui = undefined;

  const controls = document.getElementById('lab-controls') as ControlsWithGui | null;
  if (controls) {
    controls.__labGui = undefined;
  }
}

function renderMessage(title: string, message: string): void {
  const { canvas, controls } = getLabElements();

  canvas.replaceChildren();
  controls.replaceChildren();

  const canvasMessage = document.createElement('div');
  canvasMessage.style.display = 'grid';
  canvasMessage.style.placeItems = 'center';
  canvasMessage.style.height = '100%';
  canvasMessage.style.padding = '32px';

  const card = document.createElement('div');
  card.style.maxWidth = '640px';
  card.style.padding = '24px';
  card.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  card.style.borderRadius = '16px';
  card.style.background = 'rgba(22, 33, 62, 0.9)';
  card.style.boxShadow = '0 16px 48px rgba(0, 0, 0, 0.3)';

  const heading = document.createElement('h1');
  heading.textContent = title;
  heading.style.marginBottom = '12px';
  heading.style.fontSize = '28px';

  const body = document.createElement('p');
  body.textContent = message;
  body.style.color = '#c9d4ff';
  body.style.lineHeight = '1.6';

  const backLink = document.createElement('a');
  backLink.href = '?';
  backLink.textContent = '← Back to labs';
  backLink.style.display = 'inline-block';
  backLink.style.marginTop = '16px';
  backLink.style.color = '#7ee0ff';

  card.append(heading, body, backLink);
  canvasMessage.append(card);
  canvas.append(canvasMessage);

  const aside = document.createElement('div');
  aside.style.padding = '16px';
  aside.style.border = '1px solid rgba(255, 255, 255, 0.08)';
  aside.style.borderRadius = '12px';
  aside.style.background = 'rgba(8, 12, 24, 0.4)';

  const asideHeading = document.createElement('h2');
  asideHeading.textContent = 'Lab status';
  asideHeading.style.marginBottom = '8px';

  const asideBody = document.createElement('p');
  asideBody.textContent = message;
  asideBody.style.color = '#c9d4ff';
  asideBody.style.lineHeight = '1.6';

  aside.append(asideHeading, asideBody);
  controls.append(aside);
}

export function runLab(labId: string): void {
  destroyActiveLab();

  const lab = getLab(labId);
  if (!lab) {
    renderMessage('Lab not found', `No lab is registered with id "${labId}".`);
    return;
  }

  const { canvas, controls } = getLabElements();
  canvas.replaceChildren();
  controls.replaceChildren();

  const header = document.createElement('section');
  header.style.marginBottom = '16px';

  const title = document.createElement('h1');
  title.textContent = lab.name;
  title.style.fontSize = '24px';
  title.style.marginBottom = '8px';

  const description = document.createElement('p');
  description.textContent = lab.description;
  description.style.color = '#c9d4ff';
  description.style.lineHeight = '1.5';

  const link = document.createElement('a');
  link.href = '?';
  link.textContent = '← All labs';
  link.style.display = 'inline-block';
  link.style.marginTop = '12px';
  link.style.color = '#7ee0ff';

  header.append(title, description, link);
  controls.append(header);

  const gui = new GUI({ autoPlace: false, container: controls, title: `${lab.name} Controls` });
  const globalControlsFolder = gui.addFolder('Global Controls');
  const globalControls = {
    mobileMoveMode: getGlobalControlsConfig().mobileMoveMode as MobileMoveMode,
  };
  globalControlsFolder
    .add(globalControls, 'mobileMoveMode', ['joystick', 'follow'])
    .name('Touch Move Mode')
    .onChange((value: MobileMoveMode) => {
      setGlobalControlsConfig({ mobileMoveMode: value });
    });
  globalControlsFolder.close();
  controls.__labGui = gui;
  activeGui = gui;

  try {
    activeCleanup = lab.create(canvas, controls) ?? undefined;
  } catch (error) {
    destroyActiveLab();
    renderMessage(
      'Lab crashed',
      error instanceof Error ? error.message : 'An unknown error occurred while starting the lab.',
    );
  }
}

const hot = (
  import.meta as ImportMeta & {
    hot?: {
      dispose: (callback: () => void) => void;
    };
  }
).hot;

if (hot) {
  hot.dispose(() => {
    destroyActiveLab();
  });
}
