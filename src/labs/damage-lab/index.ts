import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type PierceFinalState = 'destroyed' | 'returned';

interface DamageCalculatorSettings {
  incomingDamage: number;
  armor: number;
}

interface InvincibilitySettings {
  invincibilityMs: number;
  contactDamage: number;
}

interface PierceSettings {
  pierceCount: number;
  enemyCount: number;
  projectileDamage: number;
}

interface DpsSettings {
  damagePerHit: number;
  fireRate: number;
  pierce: number;
  targetArmor: number;
}

interface PierceEnemy {
  id: number;
  x: number;
  y: number;
  flashedUntil: number;
}

interface PierceSimulation {
  projectileX: number;
  projectileY: number;
  enemies: PierceEnemy[];
  hitSet: Set<number>;
  hitOrder: number[];
  active: boolean;
  finalState: PierceFinalState | null;
}

const BACKGROUND = '#0d0d14';
const CARD_BACKGROUND = 'rgba(22, 33, 62, 0.9)';
const BORDER = 'rgba(255, 255, 255, 0.12)';
const BODY_TEXT = '#e0e0e0';
const LABEL_TEXT = '#c9d4ff';
const HIGHLIGHT = '#7ee0ff';
const ENEMY_BASE = '#45567d';
const ENEMY_FLASH = '#ff5f5f';
const PANEL_PADDING = 24;
const CARD_PADDING = 16;
const PLAYER_MAX_HEALTH = 100;
const PROJECTILE_RADIUS = 4;
const ENEMY_RADIUS = 12;
const PROJECTILE_SPEED_PER_FRAME = 4;
const PROJECTILE_FLASH_MS = 180;
const PIERCE_CANVAS_HEIGHT = 80;
const DPS_CANVAS_HEIGHT = 120;
const PIERCE_LEFT_MARGIN = 28;
const PIERCE_RIGHT_MARGIN = 28;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeEffectiveDamage(incomingDamage: number, armor: number): number {
  return Math.max(1, incomingDamage - armor);
}

function computeEffectiveDps(
  damagePerHit: number,
  armor: number,
  fireRate: number,
  pierce: number,
  targetCount: number,
): number {
  const effectiveHitDamage = computeEffectiveDamage(damagePerHit, armor);
  const hitTargets = Math.min(pierce + 1, targetCount);
  return effectiveHitDamage * fireRate * hitTargets;
}

function formatNumber(value: number, digits = 0): string {
  return value.toFixed(digits);
}

function syncCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.floor(width * dpr));
  const pixelHeight = Math.max(1, Math.floor(height * dpr));

  if (canvas.width === pixelWidth && canvas.height === pixelHeight) {
    return false;
  }

  canvas.width = pixelWidth;
  canvas.height = pixelHeight;

  const context = canvas.getContext('2d');
  if (context) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);
  }

  return true;
}

function getHealthColor(ratio: number): string {
  if (ratio > 0.5) {
    return '#22c55e';
  }

  if (ratio >= 0.25) {
    return '#facc15';
  }

  return '#ef4444';
}

function createDamageLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const damageSettings: DamageCalculatorSettings = {
    incomingDamage: 25,
    armor: 5,
  };
  const invincibilitySettings: InvincibilitySettings = {
    invincibilityMs: 350,
    contactDamage: 5,
  };
  const pierceSettings: PierceSettings = {
    pierceCount: 1,
    enemyCount: 5,
    projectileDamage: 10,
  };
  const dpsSettings: DpsSettings = {
    damagePerHit: 10,
    fireRate: 3,
    pierce: 1,
    targetArmor: 0,
  };

  let playerHealth = PLAYER_MAX_HEALTH;
  let lastHitTime = -Infinity;
  let animationFrame = 0;
  let lastFrameTime = performance.now();
  const labStartTime = lastFrameTime;
  let destroyed = false;
  let simulation: PierceSimulation | null = null;
  let logLines = ['Press Fire to simulate projectile pierce through the lane.'];

  const style = document.createElement('style');
  style.textContent = `
    .damage-lab {
      min-height: 100%;
      padding: ${PANEL_PADDING}px;
      box-sizing: border-box;
      background: ${BACKGROUND};
      color: ${BODY_TEXT};
      font-family: monospace;
      overflow: auto;
    }
    .damage-lab__grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-rows: repeat(2, minmax(260px, auto));
      gap: 16px;
      min-height: 100%;
    }
    .damage-lab__card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 0;
      padding: ${CARD_PADDING}px;
      border-radius: 16px;
      border: 1px solid ${BORDER};
      background: ${CARD_BACKGROUND};
      box-sizing: border-box;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.24);
    }
    .damage-lab__card h3 {
      margin: 0;
      color: ${HIGHLIGHT};
      font-size: 18px;
      font-weight: 700;
    }
    .damage-lab__subtle {
      color: ${LABEL_TEXT};
      font-size: 12px;
      line-height: 1.5;
    }
    .damage-lab__formula,
    .damage-lab__stats,
    .damage-lab__log,
    .damage-lab__status {
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(5, 10, 24, 0.45);
      padding: 12px;
      line-height: 1.6;
    }
    .damage-lab__formula-row,
    .damage-lab__stat-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .damage-lab__label {
      color: ${LABEL_TEXT};
    }
    .damage-lab__value {
      color: ${HIGHLIGHT};
      font-weight: 700;
    }
    .damage-lab__player {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(5, 10, 24, 0.42);
    }
    .damage-lab__health-shell,
    .damage-lab__cooldown-shell {
      position: relative;
      overflow: hidden;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(88, 96, 120, 0.28);
    }
    .damage-lab__health-shell {
      height: 22px;
    }
    .damage-lab__health-fill,
    .damage-lab__cooldown-fill {
      height: 100%;
      width: 100%;
      border-radius: inherit;
      transition: width 180ms ease, background-color 180ms ease;
    }
    .damage-lab__health-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #05101f;
      font-size: 12px;
      font-weight: 700;
      text-shadow: none;
    }
    .damage-lab__cooldown-shell {
      height: 12px;
    }
    .damage-lab__actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .damage-lab__button {
      border: 1px solid rgba(126, 224, 255, 0.28);
      border-radius: 10px;
      padding: 10px 14px;
      background: rgba(10, 24, 40, 0.88);
      color: ${BODY_TEXT};
      font-family: monospace;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    .damage-lab__button:hover {
      transform: translateY(-1px);
      border-color: rgba(126, 224, 255, 0.6);
      background: rgba(17, 47, 71, 0.94);
    }
    .damage-lab__button:active {
      transform: translateY(0);
    }
    .damage-lab__canvas-wrap {
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(5, 10, 24, 0.42);
      padding: 10px;
    }
    .damage-lab__pierce-canvas {
      display: block;
      width: 100%;
      height: ${PIERCE_CANVAS_HEIGHT}px;
    }
    .damage-lab__chart {
      display: block;
      width: 100%;
      height: ${DPS_CANVAS_HEIGHT}px;
    }
    .damage-lab__log {
      min-height: 110px;
      max-height: 140px;
      overflow: auto;
      white-space: pre-line;
    }
  `;

  const root = document.createElement('div');
  root.className = 'damage-lab';

  const grid = document.createElement('div');
  grid.className = 'damage-lab__grid';
  root.append(grid);

  const damageCard = document.createElement('section');
  damageCard.className = 'damage-lab__card';
  const damageTitle = document.createElement('h3');
  damageTitle.textContent = 'Damage Calculator';
  const damageDescription = document.createElement('div');
  damageDescription.className = 'damage-lab__subtle';
  damageDescription.textContent =
    'Live visualization of armor mitigation: effectiveDamage = max(1, incoming - armor).';
  const damageFormula = document.createElement('div');
  damageFormula.className = 'damage-lab__formula';
  damageCard.append(damageTitle, damageDescription, damageFormula);

  const invincibilityCard = document.createElement('section');
  invincibilityCard.className = 'damage-lab__card';
  const invincibilityTitle = document.createElement('h3');
  invincibilityTitle.textContent = 'Invincibility Frame Tester';
  const invincibilityDescription = document.createElement('div');
  invincibilityDescription.className = 'damage-lab__subtle';
  invincibilityDescription.textContent =
    'Contact hits respect armor and block re-hits until invincibility expires.';
  const playerBox = document.createElement('div');
  playerBox.className = 'damage-lab__player';
  const playerName = document.createElement('div');
  playerName.innerHTML =
    '<span class="damage-lab__label">Entity:</span> <span class="damage-lab__value">Player</span>';
  const healthShell = document.createElement('div');
  healthShell.className = 'damage-lab__health-shell';
  const healthFill = document.createElement('div');
  healthFill.className = 'damage-lab__health-fill';
  const healthText = document.createElement('div');
  healthText.className = 'damage-lab__health-text';
  healthShell.append(healthFill, healthText);
  const invincibilityStatus = document.createElement('div');
  invincibilityStatus.className = 'damage-lab__status';
  const cooldownShell = document.createElement('div');
  cooldownShell.className = 'damage-lab__cooldown-shell';
  const cooldownFill = document.createElement('div');
  cooldownFill.className = 'damage-lab__cooldown-fill';
  cooldownShell.append(cooldownFill);
  const invincibilityActions = document.createElement('div');
  invincibilityActions.className = 'damage-lab__actions';
  const hitPlayerButton = document.createElement('button');
  hitPlayerButton.type = 'button';
  hitPlayerButton.className = 'damage-lab__button';
  hitPlayerButton.textContent = 'Hit Player';
  invincibilityActions.append(hitPlayerButton);
  playerBox.append(
    playerName,
    healthShell,
    invincibilityStatus,
    cooldownShell,
    invincibilityActions,
  );
  invincibilityCard.append(invincibilityTitle, invincibilityDescription, playerBox);

  const pierceCard = document.createElement('section');
  pierceCard.className = 'damage-lab__card';
  const pierceTitle = document.createElement('h3');
  pierceTitle.textContent = 'Pierce Simulation';
  const pierceDescription = document.createElement('div');
  pierceDescription.className = 'damage-lab__subtle';
  pierceDescription.textContent =
    'Projectile tracks hits once per enemy, keeps moving until pierce is exhausted, then destroys or clears the lane.';
  const pierceActions = document.createElement('div');
  pierceActions.className = 'damage-lab__actions';
  const fireButton = document.createElement('button');
  fireButton.type = 'button';
  fireButton.className = 'damage-lab__button';
  fireButton.textContent = 'Fire';
  pierceActions.append(fireButton);
  const pierceCanvasWrap = document.createElement('div');
  pierceCanvasWrap.className = 'damage-lab__canvas-wrap';
  const pierceCanvas = document.createElement('canvas');
  pierceCanvas.className = 'damage-lab__pierce-canvas';
  pierceCanvasWrap.append(pierceCanvas);
  const pierceLog = document.createElement('div');
  pierceLog.className = 'damage-lab__log';
  pierceCard.append(pierceTitle, pierceDescription, pierceActions, pierceCanvasWrap, pierceLog);

  const dpsCard = document.createElement('section');
  dpsCard.className = 'damage-lab__card';
  const dpsTitle = document.createElement('h3');
  dpsTitle.textContent = 'DPS Calculator';
  const dpsDescription = document.createElement('div');
  dpsDescription.className = 'damage-lab__subtle';
  dpsDescription.textContent =
    'Armor curve uses the current lane enemy count as targetCount for multi-hit throughput.';
  const dpsStats = document.createElement('div');
  dpsStats.className = 'damage-lab__stats';
  const dpsCanvasWrap = document.createElement('div');
  dpsCanvasWrap.className = 'damage-lab__canvas-wrap';
  const dpsCanvas = document.createElement('canvas');
  dpsCanvas.className = 'damage-lab__chart';
  dpsCanvasWrap.append(dpsCanvas);
  dpsCard.append(dpsTitle, dpsDescription, dpsStats, dpsCanvasWrap);

  grid.append(damageCard, invincibilityCard, pierceCard, dpsCard);
  canvasHost.append(style, root);

  const pierceContext = pierceCanvas.getContext('2d');
  const dpsContext = dpsCanvas.getContext('2d');

  if (!pierceContext || !dpsContext) {
    throw new Error('Damage lab failed to initialize 2D canvas contexts.');
  }

  const updateLog = () => {
    pierceLog.textContent = logLines.join('\n');
  };

  const addLogLine = (line: string) => {
    logLines = [...logLines, line].slice(-8);
    updateLog();
  };

  const clearLog = (line: string) => {
    logLines = [line];
    updateLog();
  };

  const buildPierceEnemies = (): PierceEnemy[] => {
    const width = Math.max(220, Math.floor(pierceCanvas.clientWidth || 500));
    const usableWidth = Math.max(1, width - PIERCE_LEFT_MARGIN - PIERCE_RIGHT_MARGIN);
    const spacing = usableWidth / (pierceSettings.enemyCount + 1);
    const y = PIERCE_CANVAS_HEIGHT / 2;

    return Array.from({ length: pierceSettings.enemyCount }, (_value, index) => ({
      id: index + 1,
      x: PIERCE_LEFT_MARGIN + spacing * (index + 1),
      y,
      flashedUntil: 0,
    }));
  };

  const resetPierceSimulation = (
    message = 'Press Fire to simulate projectile pierce through the lane.',
  ) => {
    simulation = null;
    clearLog(message);
  };

  const fireProjectile = () => {
    syncCanvasToDisplaySize(pierceCanvas);
    simulation = {
      projectileX: PIERCE_LEFT_MARGIN - 6,
      projectileY: PIERCE_CANVAS_HEIGHT / 2,
      enemies: buildPierceEnemies(),
      hitSet: new Set<number>(),
      hitOrder: [],
      active: true,
      finalState: null,
    };

    clearLog(
      `Fired projectile for ${pierceSettings.projectileDamage} damage with pierce ${pierceSettings.pierceCount}.`,
    );
  };

  const getCooldownRemaining = (now: number): number => {
    if (!Number.isFinite(lastHitTime)) {
      return 0;
    }

    return Math.max(0, lastHitTime + invincibilitySettings.invincibilityMs - now);
  };

  const hitPlayer = () => {
    const now = performance.now();
    if (getCooldownRemaining(now) > 0) {
      return;
    }

    const appliedDamage = computeEffectiveDamage(
      invincibilitySettings.contactDamage,
      damageSettings.armor,
    );
    playerHealth = Math.max(0, playerHealth - appliedDamage);
    lastHitTime = now;
  };

  const updateDamagePanel = () => {
    const rawSubtraction = damageSettings.incomingDamage - damageSettings.armor;
    const effectiveDamage = computeEffectiveDamage(
      damageSettings.incomingDamage,
      damageSettings.armor,
    );

    damageFormula.innerHTML = `
      <div class="damage-lab__formula-row"><span class="damage-lab__label">Formula</span><span class="damage-lab__value">effectiveDamage = max(1, incoming - armor)</span></div>
      <div class="damage-lab__formula-row"><span class="damage-lab__label">Incoming</span><span class="damage-lab__value">${damageSettings.incomingDamage}</span></div>
      <div class="damage-lab__formula-row"><span class="damage-lab__label">Armor</span><span class="damage-lab__value">${damageSettings.armor}</span></div>
      <div class="damage-lab__formula-row"><span class="damage-lab__label">incoming - armor</span><span class="damage-lab__value">${damageSettings.incomingDamage} - ${damageSettings.armor} = ${rawSubtraction}</span></div>
      <div class="damage-lab__formula-row"><span class="damage-lab__label">Clamp</span><span class="damage-lab__value">max(1, ${rawSubtraction}) = ${effectiveDamage}</span></div>
    `;
  };

  const updateInvincibilityPanel = (now: number) => {
    const ratio = clamp(playerHealth / PLAYER_MAX_HEALTH, 0, 1);
    const cooldownRemaining = getCooldownRemaining(now);
    const cooldownRatio = clamp(
      invincibilitySettings.invincibilityMs > 0
        ? cooldownRemaining / invincibilitySettings.invincibilityMs
        : 0,
      0,
      1,
    );
    const nextHitBlocked = cooldownRemaining > 0;
    const effectiveContactDamage = computeEffectiveDamage(
      invincibilitySettings.contactDamage,
      damageSettings.armor,
    );

    healthFill.style.width = `${ratio * 100}%`;
    healthFill.style.backgroundColor = getHealthColor(ratio);
    healthText.textContent = `${playerHealth} / ${PLAYER_MAX_HEALTH}`;
    cooldownFill.style.width = `${cooldownRatio * 100}%`;
    cooldownFill.style.backgroundColor = nextHitBlocked ? HIGHLIGHT : 'rgba(88, 96, 120, 0.5)';

    const lastHitLabel = Number.isFinite(lastHitTime)
      ? `${formatNumber(lastHitTime - labStartTime)} ms`
      : 'Never';

    invincibilityStatus.innerHTML = `
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Allowed hit damage</span><span class="damage-lab__value">${effectiveContactDamage}</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Last hit timestamp</span><span class="damage-lab__value">${lastHitLabel}</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Cooldown remaining</span><span class="damage-lab__value">${formatNumber(cooldownRemaining)} ms</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Next hit blocked</span><span class="damage-lab__value">${nextHitBlocked ? 'Yes' : 'No'}</span></div>
    `;
  };

  const renderPierceCanvas = (now: number) => {
    const width = Math.max(1, pierceCanvas.clientWidth);
    const height = Math.max(1, pierceCanvas.clientHeight);

    pierceContext.clearRect(0, 0, width, height);
    pierceContext.fillStyle = 'rgba(9, 14, 28, 0.9)';
    pierceContext.fillRect(0, 0, width, height);

    pierceContext.strokeStyle = 'rgba(126, 224, 255, 0.16)';
    pierceContext.lineWidth = 1;
    pierceContext.beginPath();
    pierceContext.moveTo(PIERCE_LEFT_MARGIN - 10, height / 2);
    pierceContext.lineTo(width - PIERCE_RIGHT_MARGIN + 10, height / 2);
    pierceContext.stroke();

    const enemies = simulation?.enemies ?? buildPierceEnemies();
    for (const enemy of enemies) {
      const isHit = simulation?.hitSet.has(enemy.id) ?? false;
      const isFlashing = now < enemy.flashedUntil;
      pierceContext.fillStyle = isFlashing ? ENEMY_FLASH : isHit ? '#8a3a3a' : ENEMY_BASE;
      pierceContext.beginPath();
      pierceContext.arc(enemy.x, enemy.y, ENEMY_RADIUS, 0, Math.PI * 2);
      pierceContext.fill();

      pierceContext.fillStyle = BODY_TEXT;
      pierceContext.font = '11px monospace';
      pierceContext.textAlign = 'center';
      pierceContext.textBaseline = 'middle';
      pierceContext.fillText(String(enemy.id), enemy.x, enemy.y);
    }

    if (simulation) {
      pierceContext.fillStyle = HIGHLIGHT;
      pierceContext.beginPath();
      pierceContext.arc(
        simulation.projectileX,
        simulation.projectileY,
        PROJECTILE_RADIUS,
        0,
        Math.PI * 2,
      );
      pierceContext.fill();
    }
  };

  const advancePierceSimulation = (now: number, deltaMs: number) => {
    if (!simulation || !simulation.active) {
      return;
    }

    const step = PROJECTILE_SPEED_PER_FRAME * (deltaMs / (1000 / 60));
    simulation.projectileX += step;

    for (const enemy of simulation.enemies) {
      if (simulation.hitSet.has(enemy.id)) {
        continue;
      }

      if (simulation.projectileX + PROJECTILE_RADIUS < enemy.x - ENEMY_RADIUS) {
        continue;
      }

      simulation.hitSet.add(enemy.id);
      simulation.hitOrder.push(enemy.id);
      enemy.flashedUntil = now + PROJECTILE_FLASH_MS;
      addLogLine(`Hit enemy ${enemy.id} for ${pierceSettings.projectileDamage} damage.`);

      if (simulation.hitOrder.length > pierceSettings.pierceCount) {
        simulation.active = false;
        simulation.finalState = 'destroyed';
        addLogLine(
          `Final state: destroyed after hit ${simulation.hitOrder.length} exceeded pierce ${pierceSettings.pierceCount}.`,
        );
        return;
      }
    }

    const canvasWidth = Math.max(1, pierceCanvas.clientWidth || 500);
    if (simulation.projectileX - PROJECTILE_RADIUS > canvasWidth - PIERCE_RIGHT_MARGIN + 20) {
      simulation.active = false;
      simulation.finalState = 'returned';
      addLogLine('Final state: returned after clearing the full target row.');
    }
  };

  const renderDpsChart = () => {
    const width = Math.max(1, dpsCanvas.clientWidth);
    const height = Math.max(1, dpsCanvas.clientHeight);
    const left = 34;
    const right = 10;
    const top = 12;
    const bottom = 24;
    const plotWidth = Math.max(1, width - left - right);
    const plotHeight = Math.max(1, height - top - bottom);
    const targetCount = Math.max(1, pierceSettings.enemyCount);
    const dpsValues = Array.from({ length: 51 }, (_value, armor) =>
      computeEffectiveDps(
        dpsSettings.damagePerHit,
        armor,
        dpsSettings.fireRate,
        dpsSettings.pierce,
        targetCount,
      ),
    );
    const maxDps = Math.max(...dpsValues, 1);

    dpsContext.clearRect(0, 0, width, height);
    dpsContext.fillStyle = 'rgba(9, 14, 28, 0.92)';
    dpsContext.fillRect(0, 0, width, height);

    dpsContext.strokeStyle = 'rgba(201, 212, 255, 0.18)';
    dpsContext.lineWidth = 1;
    dpsContext.beginPath();
    dpsContext.moveTo(left, top);
    dpsContext.lineTo(left, height - bottom);
    dpsContext.lineTo(width - right, height - bottom);
    dpsContext.stroke();

    dpsContext.fillStyle = LABEL_TEXT;
    dpsContext.font = '11px monospace';
    dpsContext.textAlign = 'left';
    dpsContext.textBaseline = 'middle';
    dpsContext.fillText(`DPS ${formatNumber(maxDps)}`, 4, top + 4);
    dpsContext.fillText('0', left - 12, height - bottom);
    dpsContext.fillText('Armor', width - 42, height - 8);
    dpsContext.fillText('50', width - right - 8, height - bottom + 12);

    dpsContext.strokeStyle = HIGHLIGHT;
    dpsContext.lineWidth = 2;
    dpsContext.beginPath();
    dpsValues.forEach((value, armor) => {
      const x = left + (armor / 50) * plotWidth;
      const y = top + plotHeight - (value / maxDps) * plotHeight;
      if (armor === 0) {
        dpsContext.moveTo(x, y);
      } else {
        dpsContext.lineTo(x, y);
      }
    });
    dpsContext.stroke();

    const currentDps = computeEffectiveDps(
      dpsSettings.damagePerHit,
      dpsSettings.targetArmor,
      dpsSettings.fireRate,
      dpsSettings.pierce,
      targetCount,
    );
    const pointX = left + (dpsSettings.targetArmor / 50) * plotWidth;
    const pointY = top + plotHeight - (currentDps / maxDps) * plotHeight;
    dpsContext.fillStyle = '#ffffff';
    dpsContext.beginPath();
    dpsContext.arc(pointX, pointY, 3, 0, Math.PI * 2);
    dpsContext.fill();
  };

  const updateDpsPanel = () => {
    const targetCount = Math.max(1, pierceSettings.enemyCount);
    const effectiveHitDamage = computeEffectiveDamage(
      dpsSettings.damagePerHit,
      dpsSettings.targetArmor,
    );
    const hitTargets = Math.min(dpsSettings.pierce + 1, targetCount);
    const effectiveDps = computeEffectiveDps(
      dpsSettings.damagePerHit,
      dpsSettings.targetArmor,
      dpsSettings.fireRate,
      dpsSettings.pierce,
      targetCount,
    );

    dpsStats.innerHTML = `
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Formula</span><span class="damage-lab__value">max(1, damagePerHit - armor) × fireRate × min(pierce+1, targetCount)</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Effective hit damage</span><span class="damage-lab__value">max(1, ${dpsSettings.damagePerHit} - ${dpsSettings.targetArmor}) = ${effectiveHitDamage}</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Targets hit</span><span class="damage-lab__value">min(${dpsSettings.pierce + 1}, ${targetCount}) = ${hitTargets}</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Effective DPS</span><span class="damage-lab__value">${effectiveHitDamage} × ${formatNumber(dpsSettings.fireRate, 1)} × ${hitTargets} = ${formatNumber(effectiveDps, 1)}</span></div>
    `;
  };

  const updateAllTextPanels = () => {
    updateDamagePanel();
    updateDpsPanel();
    updateInvincibilityPanel(performance.now());
    renderPierceCanvas(performance.now());
    renderDpsChart();
  };

  hitPlayerButton.addEventListener('click', hitPlayer);
  fireButton.addEventListener('click', fireProjectile);

  const damageFolder = gui.addFolder('Damage Calculator');
  damageFolder
    .add(damageSettings, 'incomingDamage', 1, 200, 1)
    .name('incomingDamage')
    .onChange(updateAllTextPanels);
  damageFolder.add(damageSettings, 'armor', 0, 50, 1).name('armor').onChange(updateAllTextPanels);
  damageFolder.open();

  const invincibilityFolder = gui.addFolder('Invincibility');
  invincibilityFolder
    .add(invincibilitySettings, 'invincibilityMs', 50, 1000, 1)
    .name('invincibilityMs')
    .onChange(updateAllTextPanels);
  invincibilityFolder
    .add(invincibilitySettings, 'contactDamage', 1, 100, 1)
    .name('contactDamage')
    .onChange(updateAllTextPanels);
  invincibilityFolder.open();

  const pierceActionsObject = { Fire: fireProjectile };
  const pierceFolder = gui.addFolder('Pierce');
  pierceFolder
    .add(pierceSettings, 'pierceCount', 0, 10, 1)
    .name('pierceCount')
    .onChange(() => {
      resetPierceSimulation();
      updateAllTextPanels();
    });
  pierceFolder
    .add(pierceSettings, 'enemyCount', 1, 10, 1)
    .name('enemyCount')
    .onChange(() => {
      resetPierceSimulation();
      updateAllTextPanels();
    });
  pierceFolder
    .add(pierceSettings, 'projectileDamage', 1, 100, 1)
    .name('projectileDamage')
    .onChange(() => {
      resetPierceSimulation();
      updateAllTextPanels();
    });
  pierceFolder.add(pierceActionsObject, 'Fire').name('Fire');
  pierceFolder.open();

  const dpsFolder = gui.addFolder('DPS');
  dpsFolder
    .add(dpsSettings, 'damagePerHit', 1, 200, 1)
    .name('damagePerHit')
    .onChange(updateAllTextPanels);
  dpsFolder
    .add(dpsSettings, 'fireRate', 0.5, 20, 0.5)
    .name('fireRate')
    .onChange(updateAllTextPanels);
  dpsFolder.add(dpsSettings, 'pierce', 0, 10, 1).name('pierce').onChange(updateAllTextPanels);
  dpsFolder
    .add(dpsSettings, 'targetArmor', 0, 50, 1)
    .name('targetArmor')
    .onChange(updateAllTextPanels);
  dpsFolder.open();

  const frame = (now: number) => {
    if (destroyed) {
      return;
    }

    const deltaMs = now - lastFrameTime;
    lastFrameTime = now;

    syncCanvasToDisplaySize(pierceCanvas);
    syncCanvasToDisplaySize(dpsCanvas);
    updateInvincibilityPanel(now);
    advancePierceSimulation(now, deltaMs);
    renderPierceCanvas(now);
    renderDpsChart();

    animationFrame = requestAnimationFrame(frame);
  };

  updateDamagePanel();
  updateDpsPanel();
  updateLog();
  animationFrame = requestAnimationFrame(frame);

  return () => {
    destroyed = true;
    cancelAnimationFrame(animationFrame);
    hitPlayerButton.removeEventListener('click', hitPlayer);
    fireButton.removeEventListener('click', fireProjectile);
    root.remove();
    style.remove();
  };
}

registerLab('damage-lab', {
  category: 'Combat' as LabCategory,
  name: 'Damage Lab',
  description: 'Interactive sandbox for validating damage formulas, i-frames, pierce, and DPS.',
  create: createDamageLab,
});
