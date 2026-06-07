// Extension: equipment-viewer
// Paper doll equipment viewer — 16 slots around a character silhouette with live stat display.

import { createServer } from 'node:http';
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { renderHtml } from './renderer.mjs';
import {
  SLOT_REGISTRY,
  DEFAULT_BASE_STATS,
  STAT_CLAMPS,
  PRIMARY_STATS,
  SECONDARY_STATS,
} from './data.mjs';

const servers = new Map();
const states = new Map(); // instanceId → equipment state

function createEmptyState() {
  const equipped = {};
  for (const slot of SLOT_REGISTRY) {
    equipped[slot.id] = null;
  }
  return {
    equipped,
    instances: {}, // instanceId → { instanceId, def }
    nextInstanceId: 1,
    baseStats: { ...DEFAULT_BASE_STATS },
    effectiveStats: { ...DEFAULT_BASE_STATS },
  };
}

function clampStat(statId, value) {
  const clamp = STAT_CLAMPS[statId];
  if (!clamp) return value;
  let v = value;
  if (clamp.min !== undefined) v = Math.max(clamp.min, v);
  if (clamp.max !== undefined) v = Math.min(clamp.max, v);
  return v;
}

function recomputeStats(state) {
  const effective = { ...state.baseStats };
  const seenInstances = new Set();
  for (const slotId of Object.keys(state.equipped)) {
    const instId = state.equipped[slotId];
    if (instId === null || seenInstances.has(instId)) continue;
    seenInstances.add(instId);
    const inst = state.instances[instId];
    if (!inst) continue;
    for (const [stat, bonus] of Object.entries(inst.def.statBonuses || {})) {
      effective[stat] = (effective[stat] || 0) + bonus;
    }
  }
  for (const stat of Object.keys(effective)) {
    effective[stat] = clampStat(stat, effective[stat]);
  }
  state.effectiveStats = effective;
}

function equipItem(state, itemDef) {
  if (!itemDef.slots || !Array.isArray(itemDef.slots) || itemDef.slots.length === 0) {
    return {
      ok: false,
      reasons: [{ type: 'invalidDef', message: 'Item must have at least one slot' }],
    };
  }
  if (new Set(itemDef.slots).size !== itemDef.slots.length) {
    return { ok: false, reasons: [{ type: 'invalidDef', message: 'Item has duplicate slots' }] };
  }
  for (const slotId of itemDef.slots) {
    if (!SLOT_REGISTRY.find((s) => s.id === slotId)) {
      return { ok: false, reasons: [{ type: 'unknownSlot', slotId }] };
    }
    if (state.equipped[slotId] !== null) {
      return { ok: false, reasons: [{ type: 'occupiedSlot', slotId }] };
    }
  }
  const instId = state.nextInstanceId++;
  for (const slotId of itemDef.slots) {
    state.equipped[slotId] = instId;
  }
  state.instances[instId] = { instanceId: instId, def: itemDef };
  recomputeStats(state);
  return { ok: true, instanceId: instId };
}

function unequipSlot(state, slotId) {
  const instId = state.equipped[slotId];
  if (instId === null) return { ok: false, reason: 'Slot is empty' };
  const inst = state.instances[instId];
  for (const sid of Object.keys(state.equipped)) {
    if (state.equipped[sid] === instId) state.equipped[sid] = null;
  }
  delete state.instances[instId];
  recomputeStats(state);
  return { ok: true, item: inst };
}

// SSE clients per instance
const sseClients = new Map(); // instanceId → Set<res>

function notifyClients(instanceId) {
  const clients = sseClients.get(instanceId);
  if (!clients) return;
  const state = states.get(instanceId) || createEmptyState();
  const data = JSON.stringify({
    equipped: state.equipped,
    instances: state.instances,
    baseStats: state.baseStats,
    effectiveStats: state.effectiveStats,
  });
  for (const res of clients) {
    res.write(`data: ${data}\n\n`);
  }
}

async function startServer(instanceId) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (!sseClients.has(instanceId)) sseClients.set(instanceId, new Set());
      sseClients.get(instanceId).add(res);
      req.on('close', () => sseClients.get(instanceId)?.delete(res));
      // Send initial state
      const state = states.get(instanceId) || createEmptyState();
      res.write(
        `data: ${JSON.stringify({
          equipped: state.equipped,
          instances: state.instances,
          baseStats: state.baseStats,
          effectiveStats: state.effectiveStats,
        })}\n\n`,
      );
      return;
    }

    if (url.pathname === '/api/state') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(states.get(instanceId) || createEmptyState()));
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderHtml(instanceId));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: 'equipment-viewer',
      displayName: 'Equipment Viewer',
      description:
        'Paper doll equipment viewer with 16 slots and live stat display. Open to visualise equipment layout and stat bonuses.',
      inputSchema: {
        type: 'object',
        properties: {
          baseStats: {
            type: 'object',
            description: 'Optional base stats override',
          },
        },
      },
      actions: [
        {
          name: 'equip_item',
          description: 'Equip an item to the paper doll. Returns ok/reasons.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Item definition ID' },
              name: { type: 'string', description: 'Display name' },
              slots: {
                type: 'array',
                items: { type: 'string' },
                description: 'Slot IDs this item occupies',
              },
              statBonuses: {
                type: 'object',
                description: 'Map of statId → bonus value',
              },
              rarity: {
                type: 'string',
                enum: ['common', 'uncommon', 'rare', 'epic', 'legendary'],
              },
            },
            required: ['id', 'name', 'slots', 'rarity'],
          },
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            const result = equipItem(state, ctx.input);
            notifyClients(ctx.instanceId);
            return result;
          },
        },
        {
          name: 'unequip_slot',
          description: 'Unequip the item in a given slot.',
          inputSchema: {
            type: 'object',
            properties: {
              slotId: { type: 'string', description: 'Slot to unequip' },
            },
            required: ['slotId'],
          },
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            const result = unequipSlot(state, ctx.input.slotId);
            notifyClients(ctx.instanceId);
            return result;
          },
        },
        {
          name: 'get_state',
          description: 'Get current equipment and stat state.',
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            return {
              equipped: state.equipped,
              instances: state.instances,
              baseStats: state.baseStats,
              effectiveStats: state.effectiveStats,
            };
          },
        },
        {
          name: 'clear_all',
          description: 'Unequip all items and reset to base stats.',
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            for (const slotId of Object.keys(state.equipped)) {
              state.equipped[slotId] = null;
            }
            state.instances = {};
            recomputeStats(state);
            notifyClients(ctx.instanceId);
            return { ok: true };
          },
        },
      ],
      open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId);
          servers.set(ctx.instanceId, entry);
        }
        if (!states.has(ctx.instanceId)) {
          const state = createEmptyState();
          if (ctx.input?.baseStats) {
            Object.assign(state.baseStats, ctx.input.baseStats);
            recomputeStats(state);
          }
          states.set(ctx.instanceId, state);
        }
        return { title: '⚔️ Equipment', url: entry.url };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise((r) => entry.server.close(() => r()));
        }
        states.delete(ctx.instanceId);
        sseClients.delete(ctx.instanceId);
      },
    }),
  ],
});
