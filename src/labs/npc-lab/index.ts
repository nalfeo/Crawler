import GUI from 'lil-gui';
import { query, setComponent } from 'bitecs';
import { Position, Player, Health } from '../../core/components.js';
import { spawnNpc, spawnPlayer } from '../../core/helpers.js';
import { npcSystem } from '../../core/systems/npcSystem.js';
import { createGameWorld } from '../../core/world.js';
import { registerLab, type LabCategory } from '../registry.js';
import { getAllNpcDefs, getNpcDef } from '../../shared/npc-types.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'npc-lab';

// Canvas dimensions matching a small room
const CANVAS_W = 480;
const CANVAS_H = 320;

// NPC position (center of canvas)
const NPC_X = CANVAS_W / 2;
const NPC_Y = CANVAS_H / 2 - 20;

// Player starts offset from NPC
const PLAYER_SPAWN_X = CANVAS_W / 2;
const PLAYER_SPAWN_Y = CANVAS_H / 2 + 80;

const PLAYER_COLOR = '#5af';
const NPC_COLOR = '#f5a';
const NPC_NEARBY_COLOR = '#ff0';
const DIALOGUE_BG = 'rgba(10,15,40,0.92)';

function createNpcLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  // --- Canvas setup ---
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.background = '#10182a';
  canvas.style.border = '1px solid rgba(255,255,255,0.1)';
  canvas.style.borderRadius = '4px';
  canvasHost.append(canvas);
  const ctx = canvas.getContext('2d')!;

  // --- Controls sidebar ---
  const hint = document.createElement('p');
  hint.textContent =
    'NPC Lab — move the player with WASD or arrow keys. Approach the NPC to trigger dialogue.';
  hint.style.color = '#c9d4ff';
  hint.style.marginTop = '12px';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  // NPC info panel
  const npcInfoTitle = document.createElement('h3');
  npcInfoTitle.textContent = 'Registered NPCs';
  npcInfoTitle.style.margin = '16px 0 6px';
  npcInfoTitle.style.color = '#e5edff';
  npcInfoTitle.style.fontSize = '14px';
  controls.append(npcInfoTitle);

  for (const def of getAllNpcDefs()) {
    const row = document.createElement('div');
    row.style.fontSize = '12px';
    row.style.color = '#9fb0d8';
    row.style.marginBottom = '6px';
    row.innerHTML = `<strong style="color:#c9d4ff">${def.name}</strong><br/>
      ID: <code>${def.id}</code> &nbsp;·&nbsp; Quests: ${def.quests.length}<br/>
      Dialogue lines: ${def.dialogue.length}`;
    controls.append(row);
  }

  // Quest panel
  const questTitle = document.createElement('h3');
  questTitle.textContent = 'Active Quests';
  questTitle.style.margin = '16px 0 6px';
  questTitle.style.color = '#e5edff';
  questTitle.style.fontSize = '14px';
  controls.append(questTitle);

  const questList = document.createElement('ul');
  questList.style.fontSize = '12px';
  questList.style.color = '#9fb0d8';
  questList.style.paddingLeft = '18px';
  controls.append(questList);

  // --- ECS world ---
  const world = createGameWorld({ seed: 42 });
  const playerEid = spawnPlayer(world, PLAYER_SPAWN_X, PLAYER_SPAWN_Y);
  setComponent(world.ecs, playerEid, Health, { current: 100, max: 100 });

  const npcEid = spawnNpc(world, NPC_X, NPC_Y, 'guild-guide');

  // --- Input ---
  const keysDown = new Set<string>();
  const PLAYER_SPEED = 2;

  function onKeyDown(e: KeyboardEvent): void {
    keysDown.add(e.key);
    // Advance dialogue on E/Enter when nearby
    if ((e.key === 'e' || e.key === 'Enter') && npcEid >= 0) {
      const instance = world.npcs.get(npcEid);
      if (instance?.nearbyPlayer) {
        const def = getNpcDef(instance.defId);
        if (def) {
          instance.dialogueIndex = (instance.dialogueIndex + 1) % def.dialogue.length;
        }
      }
    }
  }
  function onKeyUp(e: KeyboardEvent): void {
    keysDown.delete(e.key);
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // --- Render loop ---
  let rafHandle = 0;
  let running = true;

  function tick(): void {
    if (!running) return;

    // Move player
    const players = query(world.ecs, [Player, Position]);
    const p = players[0];
    if (p !== undefined) {
      let dx = 0;
      let dy = 0;
      if (keysDown.has('ArrowLeft') || keysDown.has('a')) dx -= 1;
      if (keysDown.has('ArrowRight') || keysDown.has('d')) dx += 1;
      if (keysDown.has('ArrowUp') || keysDown.has('w')) dy -= 1;
      if (keysDown.has('ArrowDown') || keysDown.has('s')) dy += 1;

      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        const nx = (world.stores.position.x[p] ?? 0) + (dx / len) * PLAYER_SPEED;
        const ny = (world.stores.position.y[p] ?? 0) + (dy / len) * PLAYER_SPEED;
        const cx = Math.max(8, Math.min(CANVAS_W - 8, nx));
        const cy = Math.max(8, Math.min(CANVAS_H - 8, ny));
        setComponent(world.ecs, p, Position, { x: cx, y: cy });
      }
    }

    // Run NPC system
    npcSystem(world);

    // Render
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Draw floor
    ctx.fillStyle = '#181f38';
    ctx.fillRect(20, 20, CANVAS_W - 40, CANVAS_H - 40);

    // Draw NPC
    if (npcEid >= 0) {
      const instance = world.npcs.get(npcEid);
      const nx = world.stores.position.x[npcEid] ?? NPC_X;
      const ny = world.stores.position.y[npcEid] ?? NPC_Y;
      ctx.fillStyle = instance?.nearbyPlayer ? NPC_NEARBY_COLOR : NPC_COLOR;
      ctx.beginPath();
      ctx.arc(nx, ny, 10, 0, Math.PI * 2);
      ctx.fill();

      // NPC label
      ctx.fillStyle = '#fff';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      const def = instance ? getNpcDef(instance.defId) : undefined;
      ctx.fillText(def?.name ?? 'NPC', nx, ny - 16);

      // Interact hint
      if (instance?.nearbyPlayer) {
        ctx.fillStyle = '#ff0';
        ctx.font = 'bold 10px monospace';
        ctx.fillText('[E] Talk', nx, ny - 26);
      }

      // Dialogue box
      if (instance?.nearbyPlayer && def) {
        const line = def.dialogue[instance.dialogueIndex]?.text ?? '';
        const boxW = Math.min(CANVAS_W - 40, 380);
        const boxX = (CANVAS_W - boxW) / 2;
        const boxY = CANVAS_H - 75;
        ctx.fillStyle = DIALOGUE_BG;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, 60, 6);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.stroke();

        ctx.fillStyle = '#f5a';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(def.name + ':', boxX + 10, boxY + 16);

        // Word-wrap dialogue text
        ctx.fillStyle = '#e5edff';
        ctx.font = '11px monospace';
        const words = line.split(' ');
        let lineText = '';
        let lineY = boxY + 30;
        for (const word of words) {
          const test = lineText ? `${lineText} ${word}` : word;
          if (ctx.measureText(test).width > boxW - 20) {
            ctx.fillText(lineText, boxX + 10, lineY);
            lineText = word;
            lineY += 14;
          } else {
            lineText = test;
          }
        }
        if (lineText) {
          ctx.fillText(lineText, boxX + 10, lineY);
        }
      }
    }

    // Draw player
    if (p !== undefined) {
      const px = world.stores.position.x[p] ?? PLAYER_SPAWN_X;
      const py = world.stores.position.y[p] ?? PLAYER_SPAWN_Y;
      ctx.fillStyle = PLAYER_COLOR;
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('You', px, py - 12);
    }

    // Update quest list sidebar
    if (npcEid >= 0) {
      const instance = world.npcs.get(npcEid);
      questList.innerHTML = '';
      for (const q of instance?.quests ?? []) {
        const li = document.createElement('li');
        li.textContent = `${q.questId} — ${q.status}`;
        questList.append(li);
      }
    }

    rafHandle = requestAnimationFrame(tick);
  }

  // GUI controls
  const actions = {
    teleportToNpc: () => {
      const players = query(world.ecs, [Player, Position]);
      const p = players[0];
      if (p !== undefined) {
        setComponent(world.ecs, p, Position, { x: NPC_X, y: NPC_Y + 30 });
      }
    },
    advanceDialogue: () => {
      if (npcEid >= 0) {
        const instance = world.npcs.get(npcEid);
        if (instance) {
          const def = getNpcDef(instance.defId);
          if (def) {
            instance.dialogueIndex = (instance.dialogueIndex + 1) % def.dialogue.length;
          }
        }
      }
    },
  };
  gui.add(actions, 'teleportToNpc').name('Teleport to NPC');
  gui.add(actions, 'advanceDialogue').name('Advance Dialogue');

  tick();

  return () => {
    running = false;
    cancelAnimationFrame(rafHandle);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    hint.remove();
    npcInfoTitle.remove();
    questTitle.remove();
    questList.remove();
    canvas.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Progression' as LabCategory,
  name: 'NPC Lab',
  description:
    'Sandbox for the NPC system — non-hostile, invincible entities with dialogue and quest assignment.',
  create: createNpcLab,
});
