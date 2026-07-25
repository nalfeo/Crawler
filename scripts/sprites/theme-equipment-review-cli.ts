#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import { createRunStore } from './store/index.js';
import type { RunStore } from './store/types.js';
import {
  applyThemeSetItemReview,
  applyThemeSetPhaseHumanReview,
  advanceThemeSetPhase,
  canAdvanceThemeSet,
  loadThemeEquipmentSetState,
  saveThemeEquipmentSetState,
  type ThemeEquipmentArtifactEvidence,
  type ThemeEquipmentSetState,
  type ThemeSetMutationResult,
} from './theme-equipment-set.js';

const reviewSchema = z
  .object({
    verdict: z.enum(['up', 'down']).nullable(),
    feedback: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

const baseCommandSchema = z.object({
  setId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

const commandSchema = z.discriminatedUnion('action', [
  baseCommandSchema.extend({ action: z.literal('state') }).strict(),
  baseCommandSchema
    .extend({
      action: z.literal('item-review'),
      itemId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      review: reviewSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  baseCommandSchema
    .extend({
      action: z.literal('set-review'),
      review: reviewSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  baseCommandSchema
    .extend({
      action: z.literal('advance'),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  baseCommandSchema
    .extend({
      action: z.literal('artifact'),
      itemId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      artifactId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    })
    .strict(),
]);

export interface ThemeEquipmentReviewCliDeps {
  readonly store: RunStore;
  readonly now: () => Date;
}

export async function executeThemeEquipmentReviewCommand(
  input: unknown,
  deps: ThemeEquipmentReviewCliDeps,
): Promise<Record<string, unknown>> {
  const command = commandSchema.parse(input);
  const state = await requireState(deps.store, command.setId);

  if (command.action === 'state') return presentState(state);
  if (command.action === 'artifact') {
    const artifact = findArtifact(state, command.itemId, command.artifactId);
    const key = artifactStoreKey(artifact);
    if (!key)
      throw new Error(`Artifact "${command.artifactId}" has no previewable stored payload.`);
    const bytes = await deps.store.get(key);
    return {
      contentType: artifact.kind === 'selected-brief' ? 'text/yaml; charset=utf-8' : 'image/png',
      base64: bytes.toString('base64'),
    };
  }

  assertExpectedRevision(state, command.expectedRevision);
  const mutation =
    command.action === 'item-review'
      ? applyThemeSetItemReview(state, command.itemId, command.review)
      : command.action === 'set-review'
        ? applyThemeSetPhaseHumanReview(state, command.review)
        : advanceThemeSetPhase(state);
  const next = requireMutation(mutation);
  const saved = await saveThemeEquipmentSetState(deps.store, next, {
    expectedRevision: command.expectedRevision,
    now: deps.now,
  });
  return presentState(saved);
}

export function presentState(state: ThemeEquipmentSetState): Record<string, unknown> {
  const advance = canAdvanceThemeSet(state);
  const weaponTypes = new Set(
    state.items.filter((item) => item.kind === 'weapon').map((item) => item.weaponType),
  );
  const coveredSlots = new Set(
    state.items.flatMap((item) => (item.kind === 'equipment' ? item.slots : [])),
  );
  return {
    ...state,
    gate: advance,
    coverage: {
      weaponTypes: [...weaponTypes].sort(),
      weaponTypeCount: weaponTypes.size,
      coveredSlots: [...coveredSlots].sort(),
      coveredSlotCount: coveredSlots.size,
    },
  };
}

function requireMutation(result: ThemeSetMutationResult): ThemeEquipmentSetState {
  if (result.ok) return result.state;
  throw new Error(result.reasons.map((reason) => reason.message).join('; '));
}

function assertExpectedRevision(state: ThemeEquipmentSetState, expectedRevision: number): void {
  if (state.stateRevision !== expectedRevision) {
    throw new Error(
      `revision-conflict: expected ${expectedRevision}, found ${state.stateRevision}; refresh before retrying`,
    );
  }
}

async function requireState(store: RunStore, setId: string): Promise<ThemeEquipmentSetState> {
  const state = await loadThemeEquipmentSetState(store, setId);
  if (!state) throw new Error(`Theme set "${setId}" was not found.`);
  return state;
}

function findArtifact(
  state: ThemeEquipmentSetState,
  itemId: string,
  artifactId: string,
): ThemeEquipmentArtifactEvidence {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Theme set item "${itemId}" was not found.`);
  for (const record of Object.values(item.phases)) {
    const artifact = record.artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact) return artifact;
  }
  throw new Error(`Artifact "${artifactId}" was not found on item "${itemId}".`);
}

function artifactStoreKey(artifact: ThemeEquipmentArtifactEvidence): string | null {
  if (artifact.kind === 'raw-sheet' && artifact.briefId && artifact.runId && artifact.summary) {
    return `${artifact.briefId}/${artifact.runId}/${artifact.summary}`;
  }
  if (
    artifact.kind === 'approved-variant' &&
    artifact.briefId &&
    artifact.runId &&
    artifact.variantIndex !== undefined
  ) {
    return `${artifact.briefId}/${artifact.runId}/processed/${String(artifact.variantIndex).padStart(2, '0')}.png`;
  }
  if (artifact.kind === 'selected-brief') {
    const match = /theme-sets\/[^/]+\/artifacts\/[^/]+\/r\d+\/brief\.yaml/.exec(artifact.uri);
    return match?.[0] ?? null;
  }
  return null;
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const encoded = argv[0];
    if (!encoded) throw new Error('Expected one base64url-encoded JSON command.');
    const command = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    const repoRoot = path.resolve(process.cwd());
    const result = await executeThemeEquipmentReviewCommand(command, {
      store: createRunStore({ repoRoot, env: process.env }),
      now: () => new Date(),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedPath === thisPath) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
