import type GUI from 'lil-gui';
import {
  formatEquipmentBalanceReport,
  formatGeneratedEquipmentDistributionReport,
  runEquipmentBalanceCohort,
  runGeneratedEquipmentDistributionFixtures,
} from '../../bootstrap/equipment-balance-harness.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createEquipmentBalanceLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.height = '100%';
  root.style.overflow = 'auto';
  root.style.padding = '24px';
  root.style.background = '#07111d';
  root.style.color = '#dbeafe';

  const title = document.createElement('h2');
  title.textContent = 'Deterministic Equipment Balance Gate';
  title.style.marginTop = '0';

  const output = document.createElement('pre');
  output.style.whiteSpace = 'pre-wrap';
  output.style.overflowWrap = 'anywhere';
  output.style.font = '13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace';
  output.style.padding = '16px';
  output.style.border = '1px solid rgba(125, 211, 252, 0.25)';
  output.style.borderRadius = '10px';
  output.style.background = 'rgba(15, 23, 42, 0.9)';

  const render = (): void => {
    output.textContent = 'Running fixed production-pipeline fixtures...';
    const balance = runEquipmentBalanceCohort();
    const distribution = runGeneratedEquipmentDistributionFixtures();
    output.textContent = `${formatEquipmentBalanceReport(balance)}\n\n${formatGeneratedEquipmentDistributionReport(distribution)}`;
  };

  const actions = { rerun: render };
  gui.add(actions, 'rerun').name('Rerun fixed gate');
  root.append(title, output);
  canvasHost.append(root);
  render();

  return () => {
    root.remove();
  };
}

registerLab('equipment-balance-lab', {
  category: 'Items & Equipment',
  name: 'Equipment Balance Gate',
  description:
    'Fixed level 1/6/11 generated-equipment cohorts measured through the real headless combat pipeline.',
  create: createEquipmentBalanceLab,
});
