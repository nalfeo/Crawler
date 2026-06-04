import { registerLab, type LabCategory } from '../registry.js';

type EntityKind = 'player' | 'enemy';

interface HealthLabSettings {
  maxHealth: number;
  damageAmount: number;
  healAmount: number;
  autoRespawn: boolean;
  respawnDelayMs: number;
}

interface HealthLabEntity {
  id: string;
  label: string;
  kind: EntityKind;
  currentHealth: number;
  maxHealth: number;
  deaths: number;
  isDead: boolean;
  respawnHandle?: number;
}

interface EntityCardRefs {
  card: HTMLDivElement;
  badge: HTMLSpanElement;
  deathCount: HTMLDivElement;
  status: HTMLDivElement;
  healthFill: HTMLDivElement;
  healthText: HTMLSpanElement;
  damageDefault: HTMLButtonElement;
  damageHeavy: HTMLButtonElement;
  heal: HTMLButtonElement;
  kill: HTMLButtonElement;
}

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

function bindGuiChange(controller: LabGuiController, handler: () => void): LabGuiController {
  controller.onChange?.(handler);
  return controller;
}

const DEFAULT_SETTINGS: HealthLabSettings = {
  maxHealth: 100,
  damageAmount: 10,
  healAmount: 10,
  autoRespawn: true,
  respawnDelayMs: 2000,
};

function createEntity(id: string, label: string, kind: EntityKind, maxHealth: number): HealthLabEntity {
  return {
    id,
    label,
    kind,
    currentHealth: maxHealth,
    maxHealth,
    deaths: 0,
    isDead: false,
  };
}

function createHealthLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: HealthLabSettings = { ...DEFAULT_SETTINGS };
  const entities: HealthLabEntity[] = [
    createEntity('player', 'Contestant Zero', 'player', settings.maxHealth),
    createEntity('enemy-1', 'Enemy Alpha', 'enemy', settings.maxHealth),
    createEntity('enemy-2', 'Enemy Beta', 'enemy', settings.maxHealth),
    createEntity('enemy-3', 'Enemy Gamma', 'enemy', settings.maxHealth),
    createEntity('enemy-4', 'Enemy Delta', 'enemy', settings.maxHealth),
  ];
  const entityCards = new Map<string, EntityCardRefs>();
  let destroyed = false;
  let gameOver = false;

  const root = document.createElement('div');
  root.className = 'health-lab';

  const style = document.createElement('style');
  style.textContent = `
    .health-lab {
      position: relative;
      min-height: 100%;
      padding: 24px;
      background: radial-gradient(circle at top, #1f2937 0%, #111827 40%, #030712 100%);
      color: #f8fafc;
      font-family: Inter, system-ui, sans-serif;
    }
    .health-lab__header {
      margin-bottom: 20px;
    }
    .health-lab__title {
      margin: 0 0 8px;
      font-size: 28px;
      font-weight: 700;
    }
    .health-lab__subtitle {
      margin: 0;
      max-width: 760px;
      color: #cbd5e1;
      line-height: 1.6;
    }
    .health-lab__grid {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: stretch;
    }
    .health-lab__card {
      flex: 1 1 280px;
      max-width: 360px;
      padding: 16px;
      border-radius: 18px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      background: rgba(15, 23, 42, 0.92);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
      transition: opacity 220ms ease, filter 220ms ease, transform 220ms ease;
    }
    .health-lab__card.is-dead {
      opacity: 0.58;
      filter: grayscale(1);
      transform: scale(0.985);
    }
    .health-lab__card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .health-lab__entity-name {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }
    .health-lab__badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.18);
      color: #bfdbfe;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .health-lab__card[data-kind='enemy'] .health-lab__badge {
      background: rgba(244, 63, 94, 0.18);
      color: #fecdd3;
    }
    .health-lab__meta,
    .health-lab__status {
      color: #cbd5e1;
      font-size: 14px;
      line-height: 1.5;
    }
    .health-lab__status {
      margin-top: 12px;
      min-height: 22px;
    }
    .health-lab__bar-shell {
      position: relative;
      overflow: hidden;
      margin-top: 14px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(30, 41, 59, 0.95);
      height: 28px;
    }
    .health-lab__bar-fill {
      height: 100%;
      width: 100%;
      border-radius: inherit;
      transition: width 220ms ease, background-color 220ms ease;
      background: linear-gradient(90deg, #22c55e, #4ade80);
    }
    .health-lab__bar-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
    }
    .health-lab__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .health-lab__button {
      flex: 1 1 120px;
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(30, 41, 59, 0.96);
      color: #f8fafc;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }
    .health-lab__button:hover:enabled {
      transform: translateY(-1px);
      border-color: rgba(96, 165, 250, 0.55);
      background: rgba(37, 99, 235, 0.24);
    }
    .health-lab__button:disabled {
      cursor: not-allowed;
      opacity: 0.42;
    }
    .health-lab__overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(2, 6, 23, 0.8);
      backdrop-filter: blur(8px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 220ms ease;
    }
    .health-lab__overlay.is-visible {
      opacity: 1;
      pointer-events: auto;
    }
    .health-lab__overlay-panel {
      min-width: 280px;
      padding: 28px 24px;
      border-radius: 20px;
      border: 1px solid rgba(248, 113, 113, 0.4);
      background: rgba(15, 23, 42, 0.96);
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.35);
      text-align: center;
    }
    .health-lab__overlay-title {
      margin: 0 0 8px;
      color: #f87171;
      font-size: 36px;
      font-weight: 800;
      letter-spacing: 0.08em;
    }
    .health-lab__overlay-copy {
      margin: 0 0 18px;
      color: #cbd5e1;
      line-height: 1.6;
    }
  `;

  const header = document.createElement('div');
  header.className = 'health-lab__header';
  header.innerHTML = `
    <h2 class="health-lab__title">Health System Visualizer</h2>
    <p class="health-lab__subtitle">Damage and heal entities to mirror the healthSystem flow: the player triggers <code>game_over</code>, while enemies drop an XP gem, fade into a dead state, and respawn on a timer.</p>
  `;

  const grid = document.createElement('div');
  grid.className = 'health-lab__grid';

  const overlay = document.createElement('div');
  overlay.className = 'health-lab__overlay';
  overlay.innerHTML = `
    <div class="health-lab__overlay-panel">
      <h3 class="health-lab__overlay-title">GAME OVER</h3>
      <p class="health-lab__overlay-copy">The player reached 0 HP and the system transitioned to <code>game_over</code>.</p>
    </div>
  `;
  const overlayPanel = overlay.firstElementChild as HTMLDivElement;
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.className = 'health-lab__button';
  resetButton.textContent = 'Reset';
  overlayPanel.append(resetButton);

  const hint = document.createElement('p');
  hint.textContent =
    'Use lil-gui to tune max HP, button damage/heal values, and enemy respawn timing.';
  hint.style.cssText =
    'padding:8px 16px;margin-top:16px;color:#93c5fd;line-height:1.6;font-family:Inter, system-ui, sans-serif;';

  root.append(style, header, grid, overlay);
  canvasHost.append(root);
  controls.append(hint);

  function clearRespawn(entity: HealthLabEntity): void {
    if (entity.respawnHandle !== undefined) {
      window.clearTimeout(entity.respawnHandle);
      entity.respawnHandle = undefined;
    }
  }

  function setGameOver(nextValue: boolean): void {
    gameOver = nextValue;
    overlay.classList.toggle('is-visible', gameOver);
  }

  function getHealthPercent(entity: HealthLabEntity): number {
    if (entity.maxHealth <= 0) {
      return 0;
    }

    return Math.max(0, Math.min(100, (entity.currentHealth / entity.maxHealth) * 100));
  }

  function getHealthBarColor(percent: number, isDead: boolean): string {
    if (isDead) {
      return 'linear-gradient(90deg, #64748b, #94a3b8)';
    }
    if (percent > 50) {
      return 'linear-gradient(90deg, #16a34a, #4ade80)';
    }
    if (percent >= 25) {
      return 'linear-gradient(90deg, #ca8a04, #facc15)';
    }
    return 'linear-gradient(90deg, #dc2626, #fb7185)';
  }

  function respawnEntity(entity: HealthLabEntity): void {
    clearRespawn(entity);
    entity.isDead = false;
    entity.maxHealth = settings.maxHealth;
    entity.currentHealth = settings.maxHealth;
    updateEntityCard(entity);
  }

  function scheduleRespawn(entity: HealthLabEntity): void {
    clearRespawn(entity);
    if (destroyed || gameOver || entity.kind !== 'enemy' || !entity.isDead || !settings.autoRespawn) {
      return;
    }

    entity.respawnHandle = window.setTimeout(() => {
      entity.respawnHandle = undefined;
      if (!destroyed) {
        respawnEntity(entity);
      }
    }, settings.respawnDelayMs);
  }

  function syncRespawnTimers(): void {
    for (const entity of entities) {
      if (entity.kind !== 'enemy' || !entity.isDead) {
        clearRespawn(entity);
        continue;
      }

      if (settings.autoRespawn && !gameOver) {
        scheduleRespawn(entity);
      } else {
        clearRespawn(entity);
      }
    }
  }

  function updateEntityCard(entity: HealthLabEntity): void {
    const refs = entityCards.get(entity.id);
    if (!refs) {
      return;
    }

    const percent = getHealthPercent(entity);
    refs.card.dataset.kind = entity.kind;
    refs.card.classList.toggle('is-dead', entity.isDead);
    refs.badge.textContent = entity.kind === 'player' ? 'Player' : 'Enemy';
    refs.deathCount.textContent = `Deaths: ${entity.deaths}`;
    refs.status.textContent = entity.isDead
      ? entity.kind === 'player'
        ? '💀 Dead • game_over triggered'
        : settings.autoRespawn
          ? `💀 Dead • XP gem dropped • respawning in ${Math.round(settings.respawnDelayMs / 100) / 10}s`
          : '💀 Dead • XP gem dropped • waiting for reset'
      : entity.kind === 'player'
        ? 'Alive • hits 0 HP => game_over'
        : 'Alive • hits 0 HP => XP gem + remove entity';
    refs.healthFill.style.width = `${percent}%`;
    refs.healthFill.style.background = getHealthBarColor(percent, entity.isDead);
    refs.healthText.textContent = `${Math.max(0, entity.currentHealth)} / ${entity.maxHealth}`;
    refs.damageDefault.textContent = `Damage -${settings.damageAmount}`;
    refs.damageHeavy.textContent = 'Damage -25';
    refs.heal.textContent = `Heal +${settings.healAmount}`;

    const disableActions = entity.isDead || gameOver;
    refs.damageDefault.disabled = disableActions;
    refs.damageHeavy.disabled = disableActions;
    refs.heal.disabled = disableActions;
    refs.kill.disabled = disableActions;
  }

  function updateAllCards(): void {
    for (const entity of entities) {
      updateEntityCard(entity);
    }
    overlay.classList.toggle('is-visible', gameOver);
  }

  function markEntityDead(entity: HealthLabEntity): void {
    if (entity.isDead) {
      return;
    }

    entity.isDead = true;
    entity.currentHealth = 0;
    entity.deaths += 1;

    if (entity.kind === 'player') {
      for (const other of entities) {
        if (other.kind === 'enemy') {
          clearRespawn(other);
        }
      }
      setGameOver(true);
    } else {
      scheduleRespawn(entity);
    }

    updateAllCards();
  }

  function applyDelta(entity: HealthLabEntity, delta: number): void {
    if (entity.isDead || gameOver) {
      return;
    }

    const nextHealth = Math.max(0, Math.min(entity.maxHealth, entity.currentHealth + delta));
    entity.currentHealth = nextHealth;

    if (nextHealth <= 0) {
      markEntityDead(entity);
      return;
    }

    updateEntityCard(entity);
  }

  function applyMaxHealth(): void {
    for (const entity of entities) {
      const ratio = entity.maxHealth > 0 ? entity.currentHealth / entity.maxHealth : 1;
      entity.maxHealth = settings.maxHealth;
      entity.currentHealth = entity.isDead ? 0 : Math.max(1, Math.round(ratio * settings.maxHealth));
    }

    syncRespawnTimers();
    updateAllCards();
  }

  function resetAll(): void {
    for (const entity of entities) {
      clearRespawn(entity);
      entity.maxHealth = settings.maxHealth;
      entity.currentHealth = settings.maxHealth;
      entity.deaths = 0;
      entity.isDead = false;
    }

    setGameOver(false);
    updateAllCards();
  }

  function createActionButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'health-lab__button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  function buildEntityCard(entity: HealthLabEntity): void {
    const card = document.createElement('div');
    card.className = 'health-lab__card';
    card.dataset.kind = entity.kind;

    const cardHeader = document.createElement('div');
    cardHeader.className = 'health-lab__card-header';

    const title = document.createElement('h3');
    title.className = 'health-lab__entity-name';
    title.textContent = entity.label;

    const badge = document.createElement('span');
    badge.className = 'health-lab__badge';

    cardHeader.append(title, badge);

    const deathCount = document.createElement('div');
    deathCount.className = 'health-lab__meta';

    const healthShell = document.createElement('div');
    healthShell.className = 'health-lab__bar-shell';

    const healthFill = document.createElement('div');
    healthFill.className = 'health-lab__bar-fill';

    const healthText = document.createElement('span');
    healthText.className = 'health-lab__bar-text';

    healthShell.append(healthFill, healthText);

    const status = document.createElement('div');
    status.className = 'health-lab__status';

    const actions = document.createElement('div');
    actions.className = 'health-lab__actions';

    const damageDefault = createActionButton('', () => {
      applyDelta(entity, -settings.damageAmount);
    });
    const damageHeavy = createActionButton('Damage -25', () => {
      applyDelta(entity, -25);
    });
    const heal = createActionButton('', () => {
      applyDelta(entity, settings.healAmount);
    });
    const kill = createActionButton('Kill', () => {
      markEntityDead(entity);
    });

    actions.append(damageDefault, damageHeavy, heal, kill);
    card.append(cardHeader, deathCount, healthShell, status, actions);
    grid.append(card);

    entityCards.set(entity.id, {
      card,
      badge,
      deathCount,
      status,
      healthFill,
      healthText,
      damageDefault,
      damageHeavy,
      heal,
      kill,
    });
  }

  for (const entity of entities) {
    buildEntityCard(entity);
  }

  resetButton.addEventListener('click', resetAll);

  const guiGroup = typeof gui.addFolder === 'function' ? gui.addFolder('Health Lab') : gui;
  const maxHealthController = bindGuiChange(
    guiGroup.add(settings, 'maxHealth', 10, 500, 1).name('maxHealth'),
    () => {
      applyMaxHealth();
    },
  );
  const damageController = bindGuiChange(
    guiGroup.add(settings, 'damageAmount', 1, 100, 1).name('damageAmount'),
    () => {
      updateAllCards();
    },
  );
  const healController = bindGuiChange(
    guiGroup.add(settings, 'healAmount', 1, 50, 1).name('healAmount'),
    () => {
      updateAllCards();
    },
  );
  const autoRespawnController = bindGuiChange(
    guiGroup.add(settings, 'autoRespawn').name('autoRespawn'),
    () => {
      syncRespawnTimers();
      updateAllCards();
    },
  );
  const respawnDelayController = bindGuiChange(
    guiGroup.add(settings, 'respawnDelayMs', 500, 5000, 100).name('respawnDelayMs'),
    () => {
      syncRespawnTimers();
      updateAllCards();
    },
  );
  const resetController = guiGroup.add({ resetAll }, 'resetAll').name('Reset All');

  guiGroup.open?.();
  maxHealthController.updateDisplay?.();
  damageController.updateDisplay?.();
  healController.updateDisplay?.();
  autoRespawnController.updateDisplay?.();
  respawnDelayController.updateDisplay?.();
  resetController.updateDisplay?.();

  updateAllCards();

  return () => {
    destroyed = true;
    for (const entity of entities) {
      clearRespawn(entity);
    }

    if (guiGroup !== gui) {
      guiGroup.destroy?.();
    }

    root.remove();
    hint.remove();
  };
}

registerLab('health-lab', {
  category: 'Combat' as LabCategory,
  name: 'Health Lab',
  description: 'Interactive DOM visualizer for health, death, and respawn behavior.',
  create: createHealthLab,
});
