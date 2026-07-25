import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import {
  createSerializedThemeEquipmentReviewRunner,
  dispatchThemeEquipmentWorkflow,
  resolveThemeSetId,
  runThemeEquipmentReviewCommand,
} from './lib/bridge.mjs';
import { startThemeEquipmentReviewServer } from './lib/server.mjs';
import { renderHtml } from './renderer.mjs';

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, '..', '..', '..');
const instances = new Map();
const pendingStartups = new Map();
let sessionRef = null;

function log(message, level = 'info') {
  try {
    sessionRef?.log?.(`[theme-equipment-review] ${message}`, { level });
  } catch {
    // Logging must never fail a canvas operation.
  }
}

const runCommand = createSerializedThemeEquipmentReviewRunner((command) =>
  runThemeEquipmentReviewCommand(command, REPO_ROOT),
);

async function ensureServer(ctx) {
  const requestedSetId = ctx.input?.setId;
  const existing = instances.get(ctx.instanceId);
  if (existing) {
    if (requestedSetId && existing.setId !== requestedSetId) {
      throw new CanvasError(
        'set_mismatch',
        `Canvas instance "${ctx.instanceId}" is already bound to "${existing.setId}".`,
      );
    }
    return existing;
  }
  const pending = pendingStartups.get(ctx.instanceId);
  if (pending) return pending;
  let setId;
  try {
    setId = resolveThemeSetId(REPO_ROOT, requestedSetId);
  } catch (error) {
    throw new CanvasError('set_required', error?.message ?? String(error));
  }
  const startup = startThemeEquipmentReviewServer({
    instanceId: ctx.instanceId,
    setId,
    repoRoot: REPO_ROOT,
    renderHtml,
    runCommand,
    dispatchWorkflow: (action) => dispatchThemeEquipmentWorkflow(REPO_ROOT, setId, action),
    log,
  }).then((server) => {
    const entry = { ...server, setId };
    instances.set(ctx.instanceId, entry);
    return entry;
  });
  pendingStartups.set(ctx.instanceId, startup);
  try {
    return await startup;
  } finally {
    pendingStartups.delete(ctx.instanceId);
  }
}

function requireInstance(instanceId) {
  const entry = instances.get(instanceId);
  if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
  return entry;
}

async function mutateAndPush(ctx, command) {
  const entry = requireInstance(ctx.instanceId);
  try {
    const state = await runCommand({ ...command, setId: entry.setId });
    await entry.pushState(state);
    return state;
  } catch (error) {
    throw new CanvasError('mutation_failed', error?.message ?? String(error));
  }
}

const canvas = createCanvas({
  id: 'theme-equipment-review',
  displayName: 'Theme Equipment Review',
  description:
    'Review themed equipment roster, briefs, sprite sheets, variants, cohesion, coverage, and phase gates.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      setId: {
        type: 'string',
        pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
        description:
          'Stable theme-equipment set ID. Omit to use the only authored set in data/theme-equipment-sets.',
      },
    },
  },
  actions: [
    {
      name: 'get_state',
      description: 'Load the current durable review state for this theme set.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = requireInstance(ctx.instanceId);
        return runCommand({ action: 'state', setId: entry.setId });
      },
    },
    {
      name: 'review_item',
      description: 'Approve, reject, or clear one item review in the current phase.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemId: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
          verdict: { type: ['string', 'null'], enum: ['up', 'down', null] },
          feedback: { type: 'string', maxLength: 2000 },
          expectedRevision: { type: 'integer', minimum: 0 },
        },
        required: ['itemId', 'verdict', 'expectedRevision'],
      },
      handler: (ctx) =>
        mutateAndPush(ctx, {
          action: 'item-review',
          itemId: ctx.input.itemId,
          review: {
            verdict: ctx.input.verdict,
            ...(ctx.input.feedback?.trim() ? { feedback: ctx.input.feedback.trim() } : {}),
          },
          expectedRevision: ctx.input.expectedRevision,
        }),
    },
    {
      name: 'review_collection',
      description: 'Approve, reject, or clear the whole-set human review in the current phase.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: ['string', 'null'], enum: ['up', 'down', null] },
          feedback: { type: 'string', maxLength: 2000 },
          expectedRevision: { type: 'integer', minimum: 0 },
        },
        required: ['verdict', 'expectedRevision'],
      },
      handler: (ctx) =>
        mutateAndPush(ctx, {
          action: 'set-review',
          review: {
            verdict: ctx.input.verdict,
            ...(ctx.input.feedback?.trim() ? { feedback: ctx.input.feedback.trim() } : {}),
          },
          expectedRevision: ctx.input.expectedRevision,
        }),
    },
    {
      name: 'advance_phase',
      description:
        'Advance only if every canonical item, human, cohesion, and coverage gate passes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { expectedRevision: { type: 'integer', minimum: 0 } },
        required: ['expectedRevision'],
      },
      handler: (ctx) =>
        mutateAndPush(ctx, {
          action: 'advance',
          expectedRevision: ctx.input.expectedRevision,
        }),
    },
    {
      name: 'dispatch_workflow',
      description:
        'Dispatch durable set initialization, paid phase generation, or atomic publication to the trusted GitHub workflow.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { action: { type: 'string', enum: ['init', 'run-phase', 'publish'] } },
        required: ['action'],
      },
      handler: async (ctx) => {
        const entry = requireInstance(ctx.instanceId);
        return dispatchThemeEquipmentWorkflow(REPO_ROOT, entry.setId, ctx.input.action);
      },
    },
  ],
  open: async (ctx) => {
    const entry = await ensureServer(ctx);
    return { title: `Theme Equipment · ${entry.setId}`, url: entry.url };
  },
  onClose: async (ctx) => {
    const entry = instances.get(ctx.instanceId);
    if (!entry) return;
    instances.delete(ctx.instanceId);
    await entry.close().catch((error) => log(`close failed: ${error?.message ?? error}`, 'warn'));
  },
});

sessionRef = await joinSession({ canvases: [canvas] });
log('canvas provider registered');
