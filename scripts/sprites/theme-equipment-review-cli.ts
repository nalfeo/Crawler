#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { z } from 'zod';
import { createRunStore } from './store/index.js';
import type { RunStore } from './store/types.js';
import {
  applyEditedThemeSetBrief,
  applyThemeSetItemReview,
  applyThemeSetPhaseHumanReview,
  approveRemainingThemeSetPhase,
  advanceThemeSetPhase,
  canAdvanceThemeSet,
  loadThemeEquipmentSetState,
  planApproveRemaining,
  planRunPhase,
  saveThemeEquipmentSetState,
  themeEquipmentSetPlanSchema,
  themeEquipmentSetStateKey,
  themeSetItemAwaitsGeneration,
  isReviewPhase,
  type ThemeEquipmentArtifactEvidence,
  type ThemeEquipmentSetPlan,
  type ThemeEquipmentSetState,
  type ThemeSetMutationResult,
} from './theme-equipment-set.js';
import { enableJudge, selectedBriefKey } from './theme-equipment-brief.js';
import { validateBriefYaml } from './load-brief.js';
import {
  synthesizeThemeRoster,
  validateRosterProposal,
  type ThemeRosterChatCaller,
} from './theme-roster-synth.js';
import { createAzureThemeRosterChatCaller } from './provider/azure-roster-chat.js';

/** Directory holding authored plans, relative to the repo root. */
export const THEME_SET_PLAN_DIR = path.join('data', 'theme-equipment-sets');
const SET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Bound on concurrent state loads when building the set index. */
const INDEX_LOAD_CONCURRENCY = 4;
/** Grace period for pooled sockets to drain before forcing exit. */
const EXIT_DRAIN_GRACE_MS = 500;

const reviewSchema = z
  .object({
    verdict: z.enum(['up', 'down']).nullable(),
    feedback: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

const baseCommandSchema = z.object({
  setId: z.string().regex(SET_ID_PATTERN),
});

const rosterBriefSchema = z.object({
  setId: z.string().regex(SET_ID_PATTERN),
  displayName: z.string().trim().min(1).max(120),
  themeDesignLanguage: z.string().trim().min(40).max(4_000),
  notes: z.string().trim().min(1).max(2_000).optional(),
});

const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  rosterBriefSchema.extend({ action: z.literal('synth-roster') }).strict(),
  z
    .object({
      action: z.literal('save-plan'),
      // The path is derived server-side from `plan.id`; no path is ever
      // accepted from a caller.
      plan: z.unknown(),
      overwrite: z.boolean().optional(),
    })
    .strict(),
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
      action: z.literal('approve-remaining'),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  baseCommandSchema
    .extend({
      action: z.literal('save-and-approve-brief'),
      itemId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      briefText: z.string().min(1).max(200_000),
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
  /** Absolute repo root; authored plans are read from and written under it. */
  readonly repoRoot: string;
  /**
   * Chat caller for roster proposals. Constructed lazily by the CLI entry
   * point so commands that never synthesize don't require Azure config.
   */
  readonly rosterChat?: () => ThemeRosterChatCaller;
}

export async function executeThemeEquipmentReviewCommand(
  input: unknown,
  deps: ThemeEquipmentReviewCliDeps,
): Promise<Record<string, unknown>> {
  const command = commandSchema.parse(input);

  if (command.action === 'list') return listThemeSets(deps);
  if (command.action === 'synth-roster') {
    if (!deps.rosterChat) throw new Error('Roster synthesis is not available in this context.');
    const { plan, attempts, repairs } = await synthesizeThemeRoster(command, {
      chat: deps.rosterChat(),
    });
    return { plan, attempts, repairs };
  }
  if (command.action === 'save-plan') return savePlan(command, deps);

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
  if (command.action === 'approve-remaining') {
    return approveRemaining(state, command.expectedRevision, deps);
  }
  if (command.action === 'save-and-approve-brief') {
    return saveAndApproveBrief(state, command, deps);
  }
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

/**
 * "Approve remaining" — up-vote every eligible, un-reviewed item in the current
 * phase in ONE compare-and-swap write. Skips rejected / ineligible items and
 * reports them. When nothing is approvable, writes nothing (avoids revision
 * churn) but still returns the skip report so the canvas can explain why.
 */
async function approveRemaining(
  state: ThemeEquipmentSetState,
  expectedRevision: number,
  deps: ThemeEquipmentReviewCliDeps,
): Promise<Record<string, unknown>> {
  const result = approveRemainingThemeSetPhase(state);
  if (!result.ok) {
    throw new Error(result.reasons.map((reason) => reason.message).join('; '));
  }
  const presented = result.changed
    ? presentState(
        await saveThemeEquipmentSetState(deps.store, result.state, {
          expectedRevision,
          now: deps.now,
        }),
      )
    : presentState(result.state);
  return {
    ...presented,
    bulkResult: {
      approved: result.approvedIds,
      alreadyUp: result.alreadyUpIds,
      skipped: result.skipped,
    },
  };
}

/**
 * "Save and Approve" a hand-edited brief. Validates the edited YAML (schema +
 * palette) BEFORE any write — a failure throws so the server returns a non-2xx
 * error and never persists a broken brief. On success it writes the enabled
 * YAML to a NEW revision key (the live brief is never overwritten), mints a
 * fresh `selected-brief` artifact pointing at it, and applies the edit +
 * up-vote in one compare-and-swap state write.
 */
async function saveAndApproveBrief(
  state: ThemeEquipmentSetState,
  command: { setId: string; itemId: string; briefText: string; expectedRevision: number },
  deps: ThemeEquipmentReviewCliDeps,
): Promise<Record<string, unknown>> {
  if (state.phase !== 'briefs') {
    throw new Error(
      `Brief edits are only allowed during phase "briefs" (current: "${state.phase}").`,
    );
  }
  const item = state.items.find((candidate) => candidate.id === command.itemId);
  if (!item) throw new Error(`Theme set item "${command.itemId}" was not found.`);

  // enableJudge parses the YAML (throws on malformed input); validateBriefYaml
  // then checks schema + palette. Both run BEFORE any store write.
  const enabledYaml = enableJudge(command.briefText);
  const validated = validateBriefYaml(enabledYaml, { projectRoot: deps.repoRoot });

  // Use a per-attempt nonce in the store key so two concurrent writers at the
  // same item.revision each write to a distinct key. The CAS on the state
  // record ensures only one writer wins; the other's key is silently orphaned.
  const newRevision = item.revision + 1;
  const nonce = randomUUID().slice(0, 8);
  const key = selectedBriefKey(state, item, newRevision, nonce);
  await deps.store.put(key, Buffer.from(enabledYaml));

  const uri = deps.store.resolve(key);
  const base = `${item.id}-brief-r${newRevision}`;
  const artifact = {
    id: `${base}-selected`,
    kind: 'selected-brief',
    uri,
    summary: `Hand-edited brief (revision ${newRevision}).`,
    provenance: 'hand-edit',
    briefId: validated.brief.name,
  };
  const evidence = {
    id: `${base}-edit`,
    kind: 'brief-edit',
    uri,
    summary: `Maintainer hand-edited the selected brief for "${item.id}".`,
    provenance: 'hand-edit',
    briefId: validated.brief.name,
  };

  const next = requireMutation(
    applyEditedThemeSetBrief(state, command.itemId, { artifact, evidence }),
  );
  const saved = await saveThemeEquipmentSetState(deps.store, next, {
    expectedRevision: command.expectedRevision,
    now: deps.now,
  });
  return presentState(saved);
}

/**
 * Per-item review readiness for the CURRENT phase only. `awaitsGeneration` is
 * true when the item has no required pipeline output yet, so the canvas hides
 * the review thumbs until a run produces something to judge (Change 8). Computed
 * only for `state.phase` (the active tab); earlier/later tabs are review-only or
 * already resolved. Empty for roster (always reviewable) and non-review phases.
 */
function buildReviewStatus(
  state: ThemeEquipmentSetState,
): Record<string, { awaitsGeneration: boolean }> {
  if (!isReviewPhase(state.phase)) return {};
  const phase = state.phase;
  const status: Record<string, { awaitsGeneration: boolean }> = {};
  for (const item of state.items) {
    status[item.id] = { awaitsGeneration: themeSetItemAwaitsGeneration(item, phase) };
  }
  return status;
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
    bulkApprove: planApproveRemaining(state),
    runPhase: planRunPhase(state),
    reviewStatus: buildReviewStatus(state),
    coverage: {
      weaponTypes: [...weaponTypes].sort(),
      weaponTypeCount: weaponTypes.size,
      coveredSlots: [...coveredSlots].sort(),
      coveredSlotCount: coveredSlots.size,
    },
  };
}

/**
 * Enumerate authored plans and pair each with its durable-state status.
 *
 * Uses ONE `list()` pass to discover which sets have state, then loads
 * only those, bounded. A store-level failure is reported as
 * `storeStatus: 'unavailable'` rather than being collapsed into "no
 * state" — otherwise a bad Azure credential would make every existing
 * remote set look uninitialized and invite a destructive re-init.
 */
export async function listThemeSets(
  deps: Pick<ThemeEquipmentReviewCliDeps, 'store' | 'repoRoot'>,
): Promise<Record<string, unknown>> {
  const plans = readAuthoredPlans(deps.repoRoot);

  let statefulIds: ReadonlySet<string> | null = null;
  let storeError: string | null = null;
  try {
    const keys = await deps.store.list('theme-sets/', { authoritative: true });
    const ids = new Set<string>();
    for (const key of keys) {
      const match = /^theme-sets\/([^/]+)\/state\.json$/.exec(key);
      if (match?.[1]) ids.add(match[1]);
    }
    statefulIds = ids;
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error);
  }

  const knownIds = [
    ...new Set([...plans.map((entry) => entry.id), ...(statefulIds ?? new Set<string>())]),
  ].sort();

  const states = new Map<string, ThemeEquipmentSetState | { error: string }>();
  if (statefulIds) {
    const pending = knownIds.filter((id) => statefulIds.has(id));
    for (let index = 0; index < pending.length; index += INDEX_LOAD_CONCURRENCY) {
      const batch = pending.slice(index, index + INDEX_LOAD_CONCURRENCY);
      await Promise.all(
        batch.map(async (id) => {
          try {
            const state = await loadThemeEquipmentSetState(deps.store, id);
            if (state) states.set(id, state);
          } catch (error) {
            states.set(id, { error: error instanceof Error ? error.message : String(error) });
          }
        }),
      );
    }
  }

  const sets = knownIds.map((id) => {
    const plan = plans.find((entry) => entry.id === id);
    return {
      id,
      displayName: plan?.plan?.displayName ?? id,
      plan: plan
        ? { status: plan.error ? 'invalid' : 'ok', ...(plan.error ? { error: plan.error } : {}) }
        : { status: 'missing' },
      ...(plan?.plan
        ? {
            planCoverage: {
              itemCount: plan.plan.weapons.length + plan.plan.equipment.length,
              weaponTypeCount: new Set(plan.plan.weapons.map((weapon) => weapon.weaponType)).size,
              coveredSlotCount: new Set(plan.plan.equipment.flatMap((entry) => entry.slots)).size,
            },
          }
        : {}),
      state: describeStateStatus(id, statefulIds, states),
    };
  });

  return {
    sets,
    storeStatus: storeError ? 'unavailable' : 'ok',
    ...(storeError ? { storeError } : {}),
    planDir: THEME_SET_PLAN_DIR.split(path.sep).join('/'),
  };
}

function describeStateStatus(
  id: string,
  statefulIds: ReadonlySet<string> | null,
  states: ReadonlyMap<string, ThemeEquipmentSetState | { error: string }>,
): Record<string, unknown> {
  if (!statefulIds) return { status: 'unknown' };
  if (!statefulIds.has(id)) return { status: 'none' };
  const loaded = states.get(id);
  if (!loaded) return { status: 'none' };
  if ('error' in loaded) return { status: 'invalid', error: loaded.error };
  const gate = canAdvanceThemeSet(loaded);
  return {
    status: 'ready',
    phase: loaded.phase,
    stateRevision: loaded.stateRevision,
    canAdvance: gate.canAdvance,
    itemCount: loaded.items.length,
  };
}

interface AuthoredPlanEntry {
  readonly id: string;
  readonly plan: ThemeEquipmentSetPlan | null;
  readonly error: string | null;
}

function readAuthoredPlans(repoRoot: string): readonly AuthoredPlanEntry[] {
  const dir = path.join(repoRoot, THEME_SET_PLAN_DIR);
  let entries: readonly string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => SET_ID_PATTERN.test(id))
    .sort()
    .map((id) => {
      try {
        const plan = themeEquipmentSetPlanSchema.parse(
          JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8')),
        );
        if (plan.id !== id) {
          return {
            id,
            plan: null,
            error: `plan declares id "${plan.id}" but lives at ${id}.json`,
          };
        }
        return { id, plan, error: null };
      } catch (error) {
        return { id, plan: null, error: error instanceof Error ? error.message : String(error) };
      }
    });
}

/**
 * Write an authored plan into the repo.
 *
 * The destination is derived entirely from the plan's own validated
 * kebab-case `id` — callers never supply a path — and the resolved path
 * is asserted to stay inside the plan directory.
 *
 * A plan whose set already has durable state is IMMUTABLE: the live
 * state is keyed only by set id and `init` refuses to recreate it, so
 * letting the plan drift would leave the picker describing one roster
 * while the board and workflow operate on another. Rename the set
 * instead; there is deliberately no override flag.
 */
export async function savePlan(
  command: { readonly plan: unknown; readonly overwrite?: boolean },
  deps: Pick<ThemeEquipmentReviewCliDeps, 'store' | 'repoRoot'>,
): Promise<Record<string, unknown>> {
  const plan = themeEquipmentSetPlanSchema.parse(command.plan);
  // Enforce the 40+ char design-language contract. The canonical plan schema
  // intentionally allows min(1) so existing hand-authored files (which predate
  // the synthesis contract) remain parseable, but saving through this path
  // must meet the same brief contract that synthesis enforces.
  if (plan.themeDesignLanguage.trim().length < 40) {
    throw new Error(
      `themeDesignLanguage must be at least 40 characters (got ${plan.themeDesignLanguage.trim().length}). ` +
        `This is a human-authored design contract that drives all downstream art prompts.`,
    );
  }
  // Re-run the production expansion so coverage/duplicate-id/slot rules
  // reject a hand-edited roster exactly as they reject a synthesized one.
  validateRosterProposal(JSON.stringify(plan), {
    setId: plan.id,
    displayName: plan.displayName,
    themeDesignLanguage: plan.themeDesignLanguage,
  });

  const dir = path.join(deps.repoRoot, THEME_SET_PLAN_DIR);
  const target = path.resolve(dir, `${plan.id}.json`);
  if (path.dirname(target) !== path.resolve(dir)) {
    throw new Error(`Refusing to write plan outside ${THEME_SET_PLAN_DIR}.`);
  }

  if (await deps.store.has(themeEquipmentSetStateKey(plan.id))) {
    throw new Error(
      `Theme set "${plan.id}" already has durable state; its plan is immutable. ` +
        `Create a new set id instead of editing an initialized set's roster.`,
    );
  }

  const exists = existsSync(target);
  if (exists && command.overwrite !== true) {
    throw new Error(
      `Plan ${THEME_SET_PLAN_DIR.split(path.sep).join('/')}/${plan.id}.json already exists. ` +
        `Pass overwrite to replace it.`,
    );
  }

  const previous = exists ? readFileSync(target, 'utf8') : null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  // `init` runs on GitHub, outside this process's serializer, so state can
  // appear between the check above and the write. Re-check and roll back so
  // a lost race is a hard error rather than silent plan/state drift. A
  // throwing re-check must roll back too: leaving the write in place would
  // be exactly the drift this guard exists to prevent.
  let raced: boolean;
  try {
    raced = await deps.store.has(themeEquipmentSetStateKey(plan.id));
  } catch (error) {
    rollback(target, previous);
    throw new Error(
      `Could not confirm theme set "${plan.id}" is still uninitialized after writing its plan; ` +
        `the write was rolled back.`,
      { cause: error },
    );
  }
  if (raced) {
    rollback(target, previous);
    throw new Error(
      `Theme set "${plan.id}" was initialized while this plan was being saved; the write was ` +
        `rolled back because an initialized set's roster is immutable.`,
    );
  }

  return {
    saved: true,
    replaced: exists,
    setId: plan.id,
    planPath: `${THEME_SET_PLAN_DIR.split(path.sep).join('/')}/${plan.id}.json`,
  };
}

function rollback(target: string, previous: string | null): void {
  if (previous === null) rmSync(target, { force: true });
  else writeFileSync(target, previous, 'utf8');
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
    // The uri is `store.resolve(key)`, which for the local store on Windows is
    // an absolute path with backslashes; normalize so the forward-slash key
    // regex matches regardless of platform/backend.
    const normalized = artifact.uri.replace(/\\/g, '/');
    const match = /theme-sets\/[^/]+\/artifacts\/[^/]+\/r\d+\/brief\.yaml/.exec(normalized);
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
      repoRoot,
      rosterChat: () => createAzureThemeRosterChatCaller({ env: process.env }),
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
  // Do NOT hard-exit: Azure roster synthesis leaves pooled keep-alive
  // sockets behind, and `process.exit()` racing their teardown trips a
  // libuv assertion on Windows (`UV_HANDLE_CLOSING`, src\win\async.c).
  // The bridge reads the exit code, so that crash turned a perfectly
  // good roster into a canvas error. Setting `exitCode` lets the loop
  // drain the pool and exit cleanly with the same status.
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // If the pool keeps the loop alive past its keep-alive timeout, do not
    // sit there until the bridge's spawn timeout kills us. The unref'd
    // timer never delays an otherwise-idle process, and by the time it
    // fires the sockets are far past the teardown race above.
    setTimeout(() => process.exit(code), EXIT_DRAIN_GRACE_MS).unref();
  });
}
