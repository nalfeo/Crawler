/**
 * AI Runner Lab
 *
 * Watch the AI play the game in real-time. Useful for:
 * - Debugging AI behavior
 * - Tuning AI parameters
 * - Showcasing the AI player
 * - Comparing AI vs human performance
 */
import Phaser from 'phaser';
import { query } from 'bitecs';
import { createFloor1MainSceneOptions } from '../../bootstrap/floor1-main-scene-options.js';
import { BootScene, MainGameScene } from '../../engine/index.js';
import { AIState, BehaviorTreeAI } from '../../game/ai/index.js';
import {
  autoAllocateStatPoints,
  autoFloor1ProgressionSystem,
} from '../../game/ai/auto-progression.js';
import type { SerializedBTNode } from '../../game/ai/behavior-tree.js';
import { Player } from '../../core/index.js';
import type { GameWorld } from '../../core/world.js';
import { registerLab, type LabCategory } from '../registry.js';

const INITIAL_SEED = 42;
const SPEED_OPTIONS = [1, 4, 16] as const;

/**
 * Live telemetry snapshot exposed on `window.__aiRunnerDebug()` for headless
 * test harnesses (e.g. Playwright). Mirrors the headless event-log `sample`
 * schema so a browser run can be aligned frame-for-frame against a headless run
 * of the same seed. Debug-only; lab scope, never shipped to the game build.
 */
export interface AiRunnerDebugSnapshot {
  polls: number;
  paused: boolean;
  speed: number;
  scenePaused: boolean | null;
  worldState: string | null;
  gameMs: number | null;
  px: number | null;
  py: number | null;
  health: number | null;
  level: number;
  gold: number;
  spellsUnlocked: boolean;
  state: string;
  reason: string;
  targetEid: number | null;
  targetX: number | null;
  targetY: number | null;
  targetDist: number | null;
  stuckFrames: number;
  pathLen: number;
  pathIndex: number;
  moveX: number;
  moveY: number;
  nextWpX: number | null;
  nextWpY: number | null;
  pathGoalKey: string | null;
  npcMem: { discovered: string[]; talked: string[]; needed: number };
  conversationNpcEid: number | null;
  modalOpen: boolean;
  runOutcome: string | null;
  quests: Record<string, { status: string; done: number; total: number }>;
}

declare global {
  interface Window {
    __aiRunnerDebug?: () => AiRunnerDebugSnapshot;
  }
}

/**
 * Pick a fresh run seed from a non-simulation entropy source. Uses
 * `crypto.getRandomValues` (NOT `Math.random`/`Date.now`) so the lab harness
 * stays clear of the sim-determinism rules while still giving a varied seed.
 */
function randomRunSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] ?? 0) % 1_000_000;
}

interface RunnerSceneInternals {
  world?: GameWorld;
  playerEid?: number;
  modalPicker?: { isOpen(): boolean; close(): void };
  conversationNpcEid?: number | null;
  queuedInteraction?: boolean;
  setSimulationSpeed(speed: number): void;
  setSimulationPaused(paused: boolean): void;
  isSimulationPaused(): boolean;
  advanceSimulationFrames(frames?: number): void;
}

function createAiRunnerLab(canvas: HTMLElement, controls: HTMLElement): () => void {
  let currentSeed = INITIAL_SEED;
  let ai = new BehaviorTreeAI({
    seed: currentSeed,
    aggression: 1,
    retreatThreshold: 0.15,
    debug: true,
  });
  let selectedSpeed = 1;
  let isPaused = true;
  let pollCount = 0;
  const lastMove = { x: 0, y: 0, action: false };
  let pathGraphics: Phaser.GameObjects.Graphics | null = null;
  let lastStepReason = '';

  const aiInputProvider = {
    poll(state: {
      moveX: number;
      moveY: number;
      action: boolean;
      pointerX: number;
      pointerY: number;
    }): void {
      pollCount += 1;
      const scene = game.scene.getScene('MainGameScene') as unknown as RunnerSceneInternals | null;
      if (scene?.world) {
        const world = scene.world as GameWorld;
        ai.poll(state, world);
        lastMove.x = state.moveX;
        lastMove.y = state.moveY;
        lastMove.action = state.action;
      } else {
        state.moveX = 0;
        state.moveY = 0;
        state.action = false;
        state.pointerX = 0;
        state.pointerY = 0;
      }
    },
    destroy(): void {
      // Nothing to clean up.
    },
  };
  // Headless-parity AI driver. The headless runner spends earned stat points and
  // claims the boss-reward heal spell every step; the in-scene level-up and
  // boss-reward flows are modal-gated, and an input-override AI cannot operate a
  // modal. Without this the browser AI keeps base HP (its only Floor 1 sustain is
  // level-up maxHp heals) and death-spirals at low health, or stalls forever on
  // the boss-reward modal. Run the same auto-driver as a post-system so the
  // browser AI matches the headless runner's progression. NPC talk is left to the
  // scene's own E-press interaction handling.
  const aiAutoDriverSystem = (world: GameWorld): void => {
    const playerEid = query(world.ecs, [Player])[0];
    if (playerEid === undefined) {
      return;
    }
    autoFloor1ProgressionSystem(world, playerEid);
    autoAllocateStatPoints(world, playerEid);
  };
  const baseSceneOptions = createFloor1MainSceneOptions();
  const sceneOptions = {
    ...baseSceneOptions,
    inputCaptureOverride: aiInputProvider,
    worldSeed: currentSeed,
    postSystems: [...baseSceneOptions.postSystems, aiAutoDriverSystem],
  };

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.WEBGL,
    parent: canvas,
    width: 1280,
    height: 720,
    backgroundColor: '#1a1a2e',
    pixelArt: true,
    scene: [BootScene, new MainGameScene(sceneOptions)],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
  };

  const game = new Phaser.Game(config);

  const getScene = (): RunnerSceneInternals | null =>
    game.scene.getScene('MainGameScene') as unknown as RunnerSceneInternals | null;

  const getPhaserScene = (): Phaser.Scene | null =>
    game.scene.getScene('MainGameScene') as Phaser.Scene | null;

  const syncSceneSimulationState = (): void => {
    const scene = getScene();
    if (!scene) {
      return;
    }
    scene.setSimulationSpeed(selectedSpeed);
    scene.setSimulationPaused(isPaused);
  };

  /**
   * Restart the run with a new seed: reseeds the world RNG (via scene options)
   * and rebuilds the AI brain so its internal RNG matches. The scene is fully
   * restarted so the floor regenerates deterministically from the new seed.
   * Always lands paused so the new opening state can be inspected.
   */
  const reseed = (nextSeed: number): void => {
    currentSeed = nextSeed;
    sceneOptions.worldSeed = currentSeed;
    ai = new BehaviorTreeAI({
      seed: currentSeed,
      aggression: 1,
      retreatThreshold: 0.15,
      debug: true,
    });
    pollCount = 0;
    lastStepReason = '';
    isPaused = true;
    pathGraphics?.destroy();
    pathGraphics = null;

    const phaserScene = getPhaserScene();
    if (phaserScene) {
      // Re-sync sim speed/pause once the restarted scene finishes create().
      phaserScene.events.once(Phaser.Scenes.Events.CREATE, () => {
        syncSceneSimulationState();
      });
      phaserScene.scene.restart();
    }
  };

  const autoAdvanceSceneUi = (): void => {
    const scene = getScene();
    const world = scene?.world;
    const playerEid = scene?.playerEid;
    if (!scene || !world || typeof playerEid !== 'number' || playerEid < 0) {
      return;
    }

    const modalPicker = scene.modalPicker;
    const objective = world.floor1?.objective;

    if (world.state === 'loadout') {
      sceneOptions.selectLoadoutOption?.(world, 0);
      modalPicker?.close();
      return;
    }

    // An open NPC conversation freezes the simulation until the dialogue is
    // advanced/closed. Keep tapping interact so the AI drives the conversation
    // to completion instead of stalling on the open dialogue box. Quests are
    // accepted on conversation open (meet*), so re-tapping never re-targets the
    // NPC — it only walks the dialogue forward until it closes.
    if (scene.conversationNpcEid !== null) {
      scene.queuedInteraction = true;
      return;
    }

    for (const [, instance] of world.npcs.entries()) {
      if (!instance.nearbyPlayer || instance.defId !== 'shopkeeper') {
        continue;
      }
      sceneOptions.shopkeeper?.returnPrize(world, playerEid);
      if (sceneOptions.shopkeeper && world.playerGold >= sceneOptions.shopkeeper.equipmentCost) {
        sceneOptions.shopkeeper.purchase(world, playerEid);
      }
      break;
    }
    sceneOptions.shopkeeper?.equip(world, playerEid);

    if (modalPicker?.isOpen()) {
      if (
        world.goalFlags.get('floor1-boss-battle-complete') === true &&
        world.featureUnlocks.spells !== true
      ) {
        sceneOptions.selectSpellFromBossBattle?.(world, playerEid, 'fireball');
        modalPicker.close();
        return;
      }
      if (
        objective?.staircaseUnlocked &&
        !objective.staircaseDiscovered &&
        Math.hypot(
          (world.stores.position.x[playerEid] ?? 0) - objective.staircasePos.x,
          (world.stores.position.y[playerEid] ?? 0) - objective.staircasePos.y,
        ) <= objective.markerRadiusPx
      ) {
        sceneOptions.onStairDescend?.(world, playerEid);
        modalPicker.close();
        return;
      }
      if (sceneOptions.shopkeeper && sceneOptions.shopkeeper.getStage(world) === 'ready-to-buy') {
        if (world.playerGold >= sceneOptions.shopkeeper.equipmentCost) {
          sceneOptions.shopkeeper.purchase(world, playerEid);
        }
        modalPicker.close();
        return;
      }
    }

    const decision = ai.getDecision();
    const shouldInteractNpc =
      decision.state === AIState.INTERACT &&
      typeof decision.targetEid === 'number' &&
      decision.targetEid >= 0 &&
      (world.npcs.get(decision.targetEid)?.nearbyPlayer ?? false);
    const nearStairs =
      objective?.staircaseUnlocked === true &&
      objective.staircaseSpawned === true &&
      !objective.staircaseDiscovered &&
      Math.hypot(
        (world.stores.position.x[playerEid] ?? 0) - objective.staircasePos.x,
        (world.stores.position.y[playerEid] ?? 0) - objective.staircasePos.y,
      ) <= objective.markerRadiusPx;
    if (shouldInteractNpc || nearStairs) {
      scene.queuedInteraction = true;
    }
  };

  const stepOneFrame = (reason: string): void => {
    const scene = getScene();
    if (!scene) {
      return;
    }
    isPaused = true;
    lastStepReason = reason;
    scene.setSimulationPaused(true);
    scene.advanceSimulationFrames(1);
    renderControls();
  };

  const ensurePathGraphics = (): Phaser.GameObjects.Graphics | null => {
    const scene = getPhaserScene();
    if (!scene) {
      return null;
    }
    if (!pathGraphics || !pathGraphics.scene) {
      pathGraphics = scene.add.graphics();
      pathGraphics.setDepth(10_000);
    }
    return pathGraphics;
  };

  const drawPathOverlay = (): void => {
    const graphics = ensurePathGraphics();
    const scene = getScene();
    const world = scene?.world;
    if (!graphics || !scene || !world || !world.floorMap) {
      return;
    }

    const decision = ai.getDecision();
    const nav = ai.getNavigationDebug();
    const playerEid = scene.playerEid;

    graphics.clear();

    if (typeof playerEid !== 'number' || playerEid < 0) {
      return;
    }
    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;

    const worldPoints = nav.pathWaypoints.map((tile) =>
      world.floorMap!.tileToPixel(tile.x, tile.y),
    );

    if (worldPoints.length > 1) {
      graphics.lineStyle(2, 0x4fc3f7, 0.95);
      graphics.beginPath();
      graphics.moveTo(playerX, playerY);
      for (const point of worldPoints) {
        graphics.lineTo(point.x, point.y);
      }
      graphics.strokePath();
    }

    const activeWaypoint =
      worldPoints[Math.min(nav.pathIndex, Math.max(0, worldPoints.length - 1))];
    if (activeWaypoint) {
      graphics.fillStyle(0xffeb3b, 0.9);
      graphics.fillCircle(activeWaypoint.x, activeWaypoint.y, 5);
    }

    if (decision.targetX !== null && decision.targetY !== null) {
      graphics.lineStyle(2, 0xff7043, 0.9);
      graphics.strokeCircle(decision.targetX, decision.targetY, 10);
    }
  };

  const renderDecisionTree = (
    treeContainer: HTMLElement,
    tree: SerializedBTNode,
    decision: { state: number; reason: string; targetX: number | null; targetY: number | null },
  ): void => {
    treeContainer.innerHTML = '';
    const root = document.createElement('div');
    root.style.cssText = 'padding: 8px; background: #151530; border-radius: 4px; margin-top: 10px;';
    treeContainer.appendChild(root);

    const stateName = getStateName(decision.state);
    const summary = document.createElement('div');
    summary.style.cssText = 'margin-bottom: 8px; font-size: 11px;';
    summary.innerHTML = `<div><strong>Decision tree</strong></div>
      <div>State: ${stateName}</div>
      <div>Reason: ${decision.reason}</div>`;
    root.appendChild(summary);

    const nodeList = document.createElement('div');
    nodeList.style.cssText =
      'font-family: monospace; font-size: 11px; max-height: 220px; overflow-y: auto;';
    root.appendChild(nodeList);

    const getNodeColor = (type: string): string => {
      switch (type) {
        case 'Sequence':
          return '#4caf50';
        case 'Selector':
          return '#ff9800';
        case 'Condition':
          return '#2196f3';
        case 'Action':
          return '#f44336';
        default:
          return '#9e9e9e';
      }
    };

    const renderNode = (node: SerializedBTNode, depth: number): void => {
      const line = document.createElement('div');
      line.style.cssText = `margin-left:${depth * 14}px; color:#ddd;`;
      line.innerHTML = `<span style="color:${getNodeColor(node.type)}">[${node.type}]</span> ${node.name}`;
      nodeList.appendChild(line);
      for (const child of node.children) {
        renderNode(child, depth + 1);
      }
    };

    renderNode(tree, 0);
  };

  const renderControls = (): void => {
    controls.innerHTML = `
      <div style="font-family: monospace; padding: 12px;">
        <h3 style="margin: 0 0 12px 0;">AI Runner Lab</h3>
        <div id="ai-info" style="font-size: 12px; line-height: 1.6;">
          <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px; flex-wrap:wrap;">
            <label for="ai-seed-input"><strong>Seed:</strong></label>
            <input id="ai-seed-input" type="number" value="${currentSeed}" style="width:96px; padding:4px; background:#151530; color:#ddd; border:1px solid #333; border-radius:3px;" />
            <button id="ai-seed-apply" type="button" style="padding:4px 8px; cursor:pointer;">Apply</button>
            <button id="ai-seed-random" type="button" style="padding:4px 8px; cursor:pointer;">🎲 Randomize</button>
          </div>
          <div id="ai-runner-status">Paused</div>
          <div id="ai-runner-debug">polls: 0</div>
          <div style="display:flex; gap:8px; margin:12px 0; flex-wrap:wrap;">
            <button id="ai-toggle-run" type="button" style="padding:6px 10px; cursor:pointer;">Resume</button>
            <button id="ai-step-frame" type="button" style="padding:6px 10px; cursor:pointer;">Advance 1 frame (Space)</button>
            <button id="ai-speed-1" type="button" style="padding:6px 10px; cursor:pointer;">1x</button>
            <button id="ai-speed-4" type="button" style="padding:6px 10px; cursor:pointer;">4x</button>
            <button id="ai-speed-16" type="button" style="padding:6px 10px; cursor:pointer;">16x</button>
          </div>
          <div id="ai-decision" style="margin-top: 8px; padding: 8px; background: #2a2a4e; border-radius: 4px;">
            <div><strong>State:</strong> <span id="ai-state">-</span></div>
            <div><strong>Reason:</strong> <span id="ai-reason">-</span></div>
            <div><strong>Target:</strong> <span id="ai-target">-</span></div>
            <div><strong>Path:</strong> <span id="ai-path">-</span></div>
          </div>
          <div id="ai-tree"></div>
          <div style="margin-top: 12px; padding: 8px; background: #1a1a3e; border-radius: 4px; font-size: 11px;">
            <div><strong>Tips:</strong></div>
            <div>• Starts paused so you can inspect the opening state</div>
            <div>• Lab auto-clears starter/shop/spell/stair UI for the AI</div>
            <div>• Use speed controls to accelerate the simulation</div>
            <div>• Cyan lines show AI path, orange circle shows current target</div>
          </div>
        </div>
      </div>
    `;

    const statusElem = document.getElementById('ai-runner-status');
    if (statusElem) {
      const scene = getScene();
      const scenePaused = scene?.isSimulationPaused?.();
      statusElem.textContent = isPaused
        ? `Paused @ ${selectedSpeed}x`
        : `Running @ ${selectedSpeed}x${scenePaused ? ' (scene paused)' : ''}`;
    }
    const debugElem = document.getElementById('ai-runner-debug');
    if (debugElem) {
      const stepSuffix = lastStepReason ? ` | step: ${lastStepReason}` : '';
      debugElem.textContent = `polls: ${pollCount}${stepSuffix}`;
    }

    const toggleButton = document.getElementById('ai-toggle-run') as HTMLButtonElement | null;
    if (toggleButton) {
      toggleButton.textContent = isPaused ? 'Resume' : 'Pause';
      toggleButton.onclick = () => {
        isPaused = !isPaused;
        syncSceneSimulationState();
        if (!isPaused) {
          lastStepReason = '';
        }
        renderControls();
      };
    }

    const stepButton = document.getElementById('ai-step-frame') as HTMLButtonElement | null;
    if (stepButton) {
      stepButton.onclick = () => {
        stepOneFrame('button');
      };
    }

    for (const speed of SPEED_OPTIONS) {
      const button = document.getElementById(`ai-speed-${speed}`) as HTMLButtonElement | null;
      if (!button) {
        continue;
      }
      button.disabled = selectedSpeed === speed;
      button.onclick = () => {
        selectedSpeed = speed;
        syncSceneSimulationState();
        renderControls();
      };
    }

    const seedInput = document.getElementById('ai-seed-input') as HTMLInputElement | null;
    const applySeed = (nextSeed: number): void => {
      reseed(nextSeed);
      renderControls();
    };
    const applyButton = document.getElementById('ai-seed-apply') as HTMLButtonElement | null;
    if (applyButton) {
      applyButton.onclick = () => {
        const parsed = Number.parseInt(seedInput?.value ?? '', 10);
        applySeed(Number.isFinite(parsed) ? parsed : currentSeed);
      };
    }
    const randomButton = document.getElementById('ai-seed-random') as HTMLButtonElement | null;
    if (randomButton) {
      randomButton.onclick = () => {
        const nextSeed = randomRunSeed();
        if (seedInput) {
          seedInput.value = String(nextSeed);
        }
        applySeed(nextSeed);
      };
    }
  };

  game.events.once('ready', () => {
    syncSceneSimulationState();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' || event.repeat) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') {
      return;
    }
    event.preventDefault();
    stepOneFrame('space');
  };
  window.addEventListener('keydown', onKeyDown);

  renderControls();

  const buildDebugSnapshot = (): AiRunnerDebugSnapshot => {
    const scene = getScene();
    const world = scene?.world;
    const playerEid = scene?.playerEid;
    const decision = ai.getDecision();
    const nav = ai.getNavigationDebug();
    const npcMemory = ai.getNpcMemoryDebug();
    const hasPlayer = !!world && typeof playerEid === 'number' && playerEid >= 0;
    const px = hasPlayer ? Math.round(world.stores.position.x[playerEid] ?? 0) : null;
    const py = hasPlayer ? Math.round(world.stores.position.y[playerEid] ?? 0) : null;
    const targetDist =
      px !== null && py !== null && decision.targetX !== null && decision.targetY !== null
        ? Math.round(Math.hypot(decision.targetX - px, decision.targetY - py))
        : null;
    const quests: AiRunnerDebugSnapshot['quests'] = {};
    if (world) {
      for (const [questId, quest] of world.questLog.entries()) {
        const doneVals = Object.values(quest.done);
        quests[questId] = {
          status: quest.status,
          done: doneVals.filter(Boolean).length,
          total: doneVals.length,
        };
      }
    }
    const neededCount = Object.values(npcMemory.neededInteractionReasons).filter(
      (reason) => typeof reason === 'string' && reason.length > 0,
    ).length;
    return {
      polls: pollCount,
      paused: isPaused,
      speed: selectedSpeed,
      scenePaused: scene?.isSimulationPaused?.() ?? null,
      worldState: world?.state ?? null,
      gameMs: world?.elapsedMs ?? null,
      px,
      py,
      health: hasPlayer ? Math.round(world.stores.health.current[playerEid] ?? 0) : null,
      level: world?.playerLevel?.level ?? 0,
      gold: world?.playerGold ?? 0,
      spellsUnlocked: world?.featureUnlocks?.spells === true,
      state: getStateName(decision.state),
      reason: decision.reason,
      targetEid: decision.targetEid,
      targetX: decision.targetX === null ? null : Math.round(decision.targetX),
      targetY: decision.targetY === null ? null : Math.round(decision.targetY),
      targetDist,
      stuckFrames: nav.stuckFrames,
      pathLen: nav.pathWaypoints.length,
      pathIndex: nav.pathIndex,
      moveX: Math.round(lastMove.x * 1000) / 1000,
      moveY: Math.round(lastMove.y * 1000) / 1000,
      nextWpX: nav.pathWaypoints[nav.pathIndex]?.x ?? null,
      nextWpY: nav.pathWaypoints[nav.pathIndex]?.y ?? null,
      pathGoalKey: nav.pathGoalKey,
      npcMem: {
        discovered: npcMemory.discoveredNpcDefs,
        talked: npcMemory.talkedNpcDefs,
        needed: neededCount,
      },
      conversationNpcEid: scene?.conversationNpcEid ?? null,
      modalOpen: scene?.modalPicker?.isOpen?.() ?? false,
      runOutcome: world?.floor1?.runSummary?.outcome ?? null,
      quests,
    };
  };
  if (typeof window !== 'undefined') {
    window.__aiRunnerDebug = buildDebugSnapshot;
  }

  const updateInterval = setInterval(() => {
    autoAdvanceSceneUi();
    const decision = ai.getDecision();
    const stateElem = document.getElementById('ai-state');
    const reasonElem = document.getElementById('ai-reason');
    const targetElem = document.getElementById('ai-target');
    const pathElem = document.getElementById('ai-path');
    const treeElem = document.getElementById('ai-tree');

    if (stateElem) {
      const stateName = getStateName(decision.state);
      stateElem.textContent = stateName;
    }

    if (reasonElem) {
      reasonElem.textContent = decision.reason;
    }

    if (targetElem) {
      if (decision.targetX !== null && decision.targetY !== null) {
        targetElem.textContent = `(${Math.round(decision.targetX)}, ${Math.round(decision.targetY)})`;
      } else {
        targetElem.textContent = 'None';
      }
    }
    if (pathElem) {
      const nav = ai.getNavigationDebug();
      pathElem.textContent =
        nav.pathWaypoints.length > 0
          ? `${nav.pathIndex + 1}/${nav.pathWaypoints.length} waypoints`
          : 'No path';
    }
    if (treeElem) {
      renderDecisionTree(treeElem, ai.getTree().serialize(), decision);
    }
    drawPathOverlay();
    const debugElem = document.getElementById('ai-runner-debug');
    if (debugElem) {
      const scene = getScene();
      const npcMemory = ai.getNpcMemoryDebug();
      const neededCount = Object.values(npcMemory.neededInteractionReasons).filter(
        (reason) => typeof reason === 'string' && reason.length > 0,
      ).length;
      debugElem.textContent = `polls: ${pollCount} | scenePaused: ${scene?.isSimulationPaused?.() ? 'yes' : 'no'} | npcMem: discovered=${npcMemory.discoveredNpcDefs.length}, talked=${npcMemory.talkedNpcDefs.length}, needed=${neededCount}`;
    }
  }, 100);

  return () => {
    clearInterval(updateInterval);
    window.removeEventListener('keydown', onKeyDown);
    if (typeof window !== 'undefined') {
      delete window.__aiRunnerDebug;
    }
    pathGraphics?.destroy();
    pathGraphics = null;
    game.destroy(true);
  };
}

function getStateName(state: number): string {
  const names = ['EXPLORE', 'ENGAGE', 'RETREAT', 'COLLECT', 'INTERACT'];
  return names[state] ?? 'UNKNOWN';
}

registerLab('ai-runner', {
  category: 'Meta' as LabCategory,
  name: 'AI Runner',
  description: 'Watch the AI play the game',
  create: createAiRunnerLab,
});
