/**
 * Death Lab — interactive visualizer for the player death → game_over flow.
 *
 * Simulates what happens when a player's HP reaches zero:
 * 1. world.state transitions to 'game_over' (set by healthSystem)
 * 2. The GameOverUI modal appears with Restart / Quit options
 * 3. Each option is highlighted here so the sequence is visible in isolation.
 *
 * Load via: ?lab=death-lab
 */
import { registerLab, type LabCategory } from '../registry.js';

type DeathLabState = 'alive' | 'dying' | 'dead';

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

function createDeathLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  let state: DeathLabState = 'alive';
  let lastChoice: 'restart' | 'quit' | null = null;
  let autoKillHandle: number | undefined;

  const params = { autoKillDelayMs: 2000, simulateOnLoad: true };

  // ── Root ──────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'death-lab';

  const style = document.createElement('style');
  style.textContent = `
    .death-lab {
      position: relative;
      min-height: 100%;
      padding: 24px;
      background: radial-gradient(circle at top, #1f0a0a 0%, #111218 40%, #030712 100%);
      color: #f8fafc;
      font-family: Inter, system-ui, sans-serif;
    }
    .death-lab__header { margin-bottom: 20px; }
    .death-lab__title { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
    .death-lab__subtitle { margin: 0; max-width: 720px; color: #cbd5e1; line-height: 1.6; }

    .death-lab__arena {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      padding: 32px;
      border: 1px solid rgba(248,113,113,0.18);
      border-radius: 18px;
      background: rgba(15,23,42,0.9);
      overflow: hidden;
    }

    .death-lab__hp-bar-shell {
      position: relative;
      width: 100%;
      max-width: 480px;
      height: 36px;
      border-radius: 999px;
      border: 1px solid rgba(148,163,184,0.2);
      background: rgba(30,41,59,0.95);
      overflow: hidden;
    }
    .death-lab__hp-bar-fill {
      height: 100%;
      width: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #16a34a, #4ade80);
      transition: width 300ms ease, background 300ms ease;
    }
    .death-lab__hp-bar-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 700;
      text-shadow: 0 1px 3px rgba(0,0,0,0.7);
    }

    .death-lab__state-badge {
      display: inline-flex;
      align-items: center;
      padding: 6px 18px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      background: rgba(34,197,94,0.18);
      color: #86efac;
      border: 1px solid rgba(34,197,94,0.35);
      transition: background 300ms, color 300ms, border-color 300ms;
    }
    .death-lab__state-badge.is-dying {
      background: rgba(251,191,36,0.18);
      color: #fde68a;
      border-color: rgba(251,191,36,0.35);
    }
    .death-lab__state-badge.is-dead {
      background: rgba(239,68,68,0.18);
      color: #fca5a5;
      border-color: rgba(239,68,68,0.35);
    }

    .death-lab__actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
    .death-lab__button {
      min-width: 140px;
      padding: 12px 20px;
      border-radius: 12px;
      border: 1px solid rgba(148,163,184,0.25);
      background: rgba(30,41,59,0.96);
      color: #f8fafc;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 150ms ease, border-color 150ms ease, background 150ms ease;
    }
    .death-lab__button:hover:enabled {
      transform: translateY(-2px);
      border-color: rgba(96,165,250,0.55);
      background: rgba(37,99,235,0.24);
    }
    .death-lab__button:disabled { cursor: not-allowed; opacity: 0.38; }
    .death-lab__button--kill {
      border-color: rgba(239,68,68,0.4);
      background: rgba(127,29,29,0.4);
    }
    .death-lab__button--kill:hover:enabled {
      border-color: rgba(239,68,68,0.7);
      background: rgba(185,28,28,0.45);
    }

    .death-lab__modal-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(2,6,23,0.82);
      backdrop-filter: blur(6px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 250ms ease;
    }
    .death-lab__modal-overlay.is-visible {
      opacity: 1;
      pointer-events: auto;
    }
    .death-lab__modal-panel {
      min-width: 320px;
      max-width: 460px;
      padding: 32px 28px;
      border-radius: 20px;
      border: 1px solid rgba(248,113,113,0.35);
      background: rgba(15,23,42,0.98);
      box-shadow: 0 24px 60px rgba(0,0,0,0.45);
      text-align: center;
    }
    .death-lab__modal-title {
      margin: 0 0 6px;
      font-size: 40px;
      font-weight: 800;
      letter-spacing: 0.06em;
      color: #ef4444;
    }
    .death-lab__modal-subtitle {
      margin: 0 0 24px;
      color: #94a3b8;
      font-size: 16px;
    }
    .death-lab__modal-options { display: flex; flex-direction: column; gap: 10px; }
    .death-lab__modal-option {
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid rgba(148,163,184,0.22);
      background: rgba(30,41,59,0.96);
      color: #f8fafc;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      transition: border-color 150ms, background 150ms;
    }
    .death-lab__modal-option:hover { border-color: rgba(96,165,250,0.55); background: rgba(37,99,235,0.22); }
    .death-lab__modal-option .option-desc { display: block; font-size: 12px; color: #94a3b8; font-weight: 400; margin-top: 2px; }

    .death-lab__result {
      margin-top: 16px;
      font-size: 14px;
      color: #93c5fd;
      min-height: 22px;
      text-align: center;
    }
  `;

  const header = document.createElement('div');
  header.className = 'death-lab__header';
  header.innerHTML = `
    <h2 class="death-lab__title">Death Screen Lab</h2>
    <p class="death-lab__subtitle">
      Simulates the <code>healthSystem → game_over</code> transition and the Game Over modal.
      When the player's HP hits zero, <code>world.state</code> becomes <code>'game_over'</code>
      and <code>GameOverUI</code> shows — offering Restart or Quit.
    </p>
  `;

  const arena = document.createElement('div');
  arena.className = 'death-lab__arena';

  // HP bar
  const hpShell = document.createElement('div');
  hpShell.className = 'death-lab__hp-bar-shell';
  const hpFill = document.createElement('div');
  hpFill.className = 'death-lab__hp-bar-fill';
  const hpText = document.createElement('span');
  hpText.className = 'death-lab__hp-bar-text';
  hpShell.append(hpFill, hpText);

  // State badge
  const stateBadge = document.createElement('div');
  stateBadge.className = 'death-lab__state-badge';

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'death-lab__actions';

  const killBtn = document.createElement('button');
  killBtn.type = 'button';
  killBtn.className = 'death-lab__button death-lab__button--kill';
  killBtn.textContent = '💀 Kill Player';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'death-lab__button';
  resetBtn.textContent = '↺ Reset';

  actions.append(killBtn, resetBtn);

  // Result line
  const resultLine = document.createElement('div');
  resultLine.className = 'death-lab__result';

  // Modal overlay (simulates GameOverUI)
  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'death-lab__modal-overlay';

  const modalPanel = document.createElement('div');
  modalPanel.className = 'death-lab__modal-panel';
  modalPanel.innerHTML = `
    <h3 class="death-lab__modal-title">GAME OVER</h3>
    <p class="death-lab__modal-subtitle">You have been slain.</p>
  `;

  const optionsList = document.createElement('div');
  optionsList.className = 'death-lab__modal-options';

  const restartOption = document.createElement('button');
  restartOption.type = 'button';
  restartOption.className = 'death-lab__modal-option';
  restartOption.innerHTML = `↺ Restart<span class="option-desc">Start over from the beginning.</span>`;

  const quitOption = document.createElement('button');
  quitOption.type = 'button';
  quitOption.className = 'death-lab__modal-option';
  quitOption.innerHTML = `← Quit<span class="option-desc">Return to the title screen.</span>`;

  optionsList.append(restartOption, quitOption);
  modalPanel.append(optionsList);
  modalOverlay.append(modalPanel);

  arena.append(hpShell, stateBadge, actions, resultLine, modalOverlay);
  root.append(style, header, arena);
  canvasHost.append(root);

  // ── State machine ─────────────────────────────────────────────────────────

  function render(): void {
    const pct = state === 'dead' ? 0 : state === 'dying' ? 10 : 100;
    hpFill.style.width = `${pct}%`;
    hpFill.style.background =
      pct > 50
        ? 'linear-gradient(90deg, #16a34a, #4ade80)'
        : pct >= 10
          ? 'linear-gradient(90deg, #ca8a04, #facc15)'
          : 'linear-gradient(90deg, #64748b, #94a3b8)';
    hpText.textContent =
      state === 'dead' ? '0 / 100' : state === 'dying' ? '10 / 100 — dying…' : '100 / 100';

    stateBadge.className = `death-lab__state-badge${state === 'dead' ? ' is-dead' : state === 'dying' ? ' is-dying' : ''}`;
    stateBadge.textContent =
      state === 'dead'
        ? 'world.state = game_over'
        : state === 'dying'
          ? 'Taking fatal damage…'
          : 'world.state = playing';

    killBtn.disabled = state !== 'alive';
    resetBtn.disabled = state === 'alive';

    modalOverlay.classList.toggle('is-visible', state === 'dead');

    if (lastChoice) {
      resultLine.textContent = `Choice recorded: "${lastChoice}" — in-game this calls window.location.reload()`;
    } else if (state === 'dead') {
      resultLine.textContent = 'Select an option above.';
    } else {
      resultLine.textContent = '';
    }
  }

  function killPlayer(): void {
    if (state !== 'alive') return;
    state = 'dying';
    lastChoice = null;
    render();
    autoKillHandle = window.setTimeout(() => {
      autoKillHandle = undefined;
      state = 'dead';
      render();
    }, params.autoKillDelayMs);
  }

  function resetAll(): void {
    if (autoKillHandle !== undefined) {
      clearTimeout(autoKillHandle);
      autoKillHandle = undefined;
    }
    state = 'alive';
    lastChoice = null;
    render();
  }

  killBtn.addEventListener('click', killPlayer);
  resetBtn.addEventListener('click', resetAll);
  restartOption.addEventListener('click', () => {
    lastChoice = 'restart';
    render();
  });
  quitOption.addEventListener('click', () => {
    lastChoice = 'quit';
    render();
  });

  // ── lil-gui ───────────────────────────────────────────────────────────────
  const guiGroup = typeof gui.addFolder === 'function' ? gui.addFolder('Death Lab') : gui;
  guiGroup
    .add(params, 'autoKillDelayMs', 0, 3000, 100)
    .name('dying → dead (ms)')
    .onChange?.(() => {});
  guiGroup.add({ killPlayer }, 'killPlayer').name('Kill Player');
  guiGroup.add({ resetAll }, 'resetAll').name('Reset');
  guiGroup.open?.();

  render();

  if (params.simulateOnLoad) {
    killPlayer();
  }

  return () => {
    if (autoKillHandle !== undefined) {
      clearTimeout(autoKillHandle);
    }
    if (guiGroup !== gui) {
      guiGroup.destroy?.();
    }
    root.remove();
  };
}

registerLab('death-lab', {
  category: 'Combat' as LabCategory,
  name: 'Death Lab',
  description: 'Visualizes the player-death → game_over transition and Game Over modal options.',
  create: createDeathLab,
});
