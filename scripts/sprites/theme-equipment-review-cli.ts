#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

/**
 * Long-lived branch that holds authored plans as the single shared "common
 * place". Publishing here (rather than to whatever workspace branch happens to
 * be checked out) lets any machine — and the `init` workflow — read the same
 * authoritative plan.
 */
const PLANS_BRANCH = 'assets/plans';
/**
 * Overall wall-clock budget for a durable publish. It is deliberately shorter
 * than the canvas bridge's per-command timeout (`DEFAULT_COMMAND_TIMEOUT_MS`,
 * 120s) so this process regains control — to verify or roll back — before the
 * bridge kills it mid-`gh` call and strands a half-completed push.
 */
const PUBLISH_DEADLINE_MS = 90_000;
/** Upper bound on any single `gh api` call within the publish budget. */
const PUBLISH_PER_CALL_MS = 25_000;
/**
 * Budget held back from the PUT so the post-PUT verification GET can always run
 * before the deadline. Without it a PUT that consumes the whole budget would
 * leave zero time to confirm whether the write actually landed, forcing a
 * local rollback while the remote copy may already be published.
 */
const PUBLISH_VERIFY_RESERVE_MS = 10_000;
/**
 * Process-start anchor for the publish deadline. Captured at module load, which
 * is effectively when the bridge spawns this CLI, so the deadline is measured
 * from the same instant as the bridge's own command timeout. Anchoring here
 * (rather than at publisher entry) guarantees the total of any upstream work —
 * e.g. the two durable-state `store.has()` probes in `savePlan` — plus the
 * publish stays inside `PUBLISH_DEADLINE_MS`, so a slow probe can never push a
 * `gh PUT` past the bridge's kill window.
 */
const PROCESS_START_MS = Date.now();

/** Input handed to a plan publisher: exactly the bytes written locally. */
export interface ThemeSetPlanPublishInput {
  readonly setId: string;
  /** Repo-relative POSIX path, e.g. `data/theme-equipment-sets/<id>.json`. */
  readonly planPath: string;
  /** The exact file contents written to disk, so the remote copy is identical. */
  readonly content: string;
  readonly displayName: string;
  readonly overwrite: boolean;
}

/** Coordinates of the published plan on the durable branch. */
export interface ThemeSetPlanPublishResult {
  readonly branch: string;
  readonly commit: string;
  readonly url: string;
}

export type ThemeSetPlanPublisher = (
  input: ThemeSetPlanPublishInput,
) => Promise<ThemeSetPlanPublishResult>;

/**
 * Failure raised by the durable plan publisher, carrying whether a later retry
 * could plausibly succeed. `savePlan` uses `retryable` to decide between keeping
 * the local write as an honest "not shared yet" pending state (transient outage)
 * versus rolling it back (definitive failure). The overwrite-refusal path stays a
 * plain `Error` because it is a definitive, user-actionable condition, not a
 * transient publisher fault.
 */
export class PlanPublishError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(
    message: string,
    opts: { readonly retryable: boolean; readonly status: number | null },
  ) {
    super(message);
    this.name = 'PlanPublishError';
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

/**
 * Classify a failed `gh api` result as retryable — a transient outage a later
 * retry could clear — versus definitive. Retryable: a genuine transport
 * transient with no HTTP status (`transient === true` — a timeout, a killed
 * child, or the publish deadline elapsing), an explicit `429`, any upstream
 * `5xx`, or a `403` that names GitHub's rate/abuse limiting. Everything else is
 * definitive: auth `401`, conflict `409`, validation `422`, a plain non-rate
 * `403`, and — crucially — a *null-status local fault* (missing `gh`, an
 * unauthenticated CLI preflight, a bad argument) that also carries no HTTP
 * status but must NOT sit pending forever. A null status is therefore retryable
 * only when the caller flagged it as a transport transient; retrying anything
 * else without the maintainer changing something is futile, so the local write
 * is rolled back as before.
 */
export function isRetryableGhFailure(result: {
  readonly status: number | null;
  readonly errorMessage: string;
  readonly transient?: boolean;
}): boolean {
  const { status, errorMessage, transient } = result;
  if (status === null) return transient === true;
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status === 403 && /rate limit|secondary rate|abuse/i.test(errorMessage)) return true;
  return false;
}

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
  /**
   * Publishes a saved plan to the durable `assets/plans` branch. Optional so
   * hermetic tests can inject a fake (or omit it for local-only saves); the
   * CLI entry point wires the real `gh`-backed publisher in `main()`.
   */
  readonly publishPlan?: ThemeSetPlanPublisher;
  /**
   * Lists plan ids published to the durable `assets/plans` branch. Optional so
   * hermetic tests can inject a fake; the CLI entry point falls back to a real
   * `git fetch` + `git ls-tree` probe when omitted.
   */
  readonly listPublishedPlanIds?: () => Promise<readonly string[]>;
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
  deps: Pick<ThemeEquipmentReviewCliDeps, 'store' | 'repoRoot' | 'listPublishedPlanIds'>,
): Promise<Record<string, unknown>> {
  const plans = readAuthoredPlans(deps.repoRoot);
  const publishedPlanIds = new Set(
    await (deps.listPublishedPlanIds?.() ?? listPublishedThemeSetIds(deps.repoRoot)).catch(
      () => [],
    ),
  );

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
    ...new Set([
      ...plans.map((entry) => entry.id),
      ...publishedPlanIds,
      ...(statefulIds ?? new Set<string>()),
    ]),
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
        : publishedPlanIds.has(id)
          ? { status: 'remote-only' }
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

export async function listPublishedThemeSetIds(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly string[]> {
  const options = {
    cwd: repoRoot,
    env: { ...env },
    encoding: 'utf8' as const,
    windowsHide: true,
    timeout: 30_000,
  };
  const scratch = `refs/theme-equipment-plans/${randomUUID()}`;
  try {
    await execFileAsync(
      'git',
      ['fetch', '--quiet', 'origin', `+${PLANS_BRANCH}:${scratch}`],
      options,
    );
    const { stdout } = await execFileAsync(
      'git',
      ['ls-tree', '-r', '--name-only', scratch, '--', THEME_SET_PLAN_DIR.split(path.sep).join('/')],
      options,
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.startsWith(`${THEME_SET_PLAN_DIR.split(path.sep).join('/')}/`) &&
          line.endsWith('.json'),
      )
      .map((line) => path.posix.basename(line, '.json'))
      .filter((id) => SET_ID_PATTERN.test(id))
      .sort();
  } finally {
    await execFileAsync('git', ['update-ref', '-d', scratch], options).catch(() => {});
  }
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
  deps: Pick<ThemeEquipmentReviewCliDeps, 'store' | 'repoRoot' | 'publishPlan'>,
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
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, content, 'utf8');

  // `init` runs on GitHub, outside this process's serializer, so state can
  // appear between the check above and the write. Re-check and roll back so
  // a lost race is a hard error rather than silent plan/state drift. A
  // throwing re-check must roll back too: leaving the write in place would
  // be exactly the drift this guard exists to prevent.
  let raced: boolean;
  try {
    raced = await deps.store.has(themeEquipmentSetStateKey(plan.id));
  } catch (error) {
    rollbackIfUnchanged(target, content, previous);
    throw new Error(
      `Could not confirm theme set "${plan.id}" is still uninitialized after writing its plan; ` +
        `the write was rolled back.`,
      { cause: error },
    );
  }
  if (raced) {
    rollbackIfUnchanged(target, content, previous);
    throw new Error(
      `Theme set "${plan.id}" was initialized while this plan was being saved; the write was ` +
        `rolled back because an initialized set's roster is immutable.`,
    );
  }

  const planPath = `${THEME_SET_PLAN_DIR.split(path.sep).join('/')}/${plan.id}.json`;

  // Push the plan to the durable `assets/plans` branch so it is the shared
  // "common place" every workspace and the init workflow read. The local
  // write alone is misleading — it implies the plan is shared when it may only
  // exist on one machine's working tree — so a definitive publish failure
  // rolls the local write back (but only if it still holds *our* bytes, so a
  // concurrent editor is never clobbered).
  //
  // NOTE: this is not atomic with `init`. `init` consumes the plan from
  // `assets/plans` into immutable durable state and is the authoritative
  // consumer; a save that races an in-flight init of the same brand-new set
  // can be dropped (last-writer-before-init-reads wins), but state is never
  // corrupted. Full cross-store atomicity would need a shared reservation
  // protocol and is intentionally out of scope.
  let durable: ThemeSetPlanPublishResult | undefined;
  if (deps.publishPlan) {
    try {
      durable = await deps.publishPlan({
        setId: plan.id,
        planPath,
        content,
        displayName: plan.displayName,
        overwrite: command.overwrite === true,
      });
    } catch (error) {
      // A transient publish outage (GitHub rate limiting, a 5xx, or a dropped
      // connection) must NOT destroy the maintainer's authored plan. Keep the
      // local write and report an honest pending state so they can retry, rather
      // than rolling back and throwing a "could not publish" error that reads
      // like data loss. This is safe with respect to `init`: init reads the plan
      // from `assets/plans`, 404s a plan that is only local, and refuses with a
      // "commit and push first" message — so a pending plan can never be mistaken
      // for a shared one. Definitive failures still roll back and throw below.
      if (error instanceof PlanPublishError && error.retryable) {
        return {
          saved: true,
          replaced: exists,
          setId: plan.id,
          planPath,
          durable: {
            branch: PLANS_BRANCH,
            pending: true,
            retryable: true,
            reason: error.message,
          },
        };
      }
      rollbackIfUnchanged(target, content, previous);
      throw new Error(
        `Saved ${plan.id} locally but could not publish it to ${PLANS_BRANCH}; the local write was ` +
          `rolled back so it does not look shared. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return {
    saved: true,
    replaced: exists,
    setId: plan.id,
    planPath,
    ...(durable ? { durable } : {}),
  };
}

function rollback(target: string, previous: string | null): void {
  if (previous === null) rmSync(target, { force: true });
  else writeFileSync(target, previous, 'utf8');
}

/**
 * Best-effort rollback: re-read the file and only restore the pre-save copy if
 * it still holds exactly the bytes we wrote. If a concurrent editor replaced
 * them first, leave their content in place. This is a content guard, not a
 * synchronized operation — the read and the restore are separate filesystem
 * calls, so a same-file edit landing in the microsecond window between them is
 * not prevented. That window is negligible for a single-maintainer dev tool
 * (it needs a human hand-editing the very same plan JSON during a failed
 * publish rollback); full atomicity would require a lock or staged install and
 * is deliberately out of scope here.
 */
function rollbackIfUnchanged(target: string, ourBytes: string, previous: string | null): void {
  let current: string | null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current !== ourBytes) return;
  rollback(target, previous);
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

/** Payload returned by an in-process artifact read (mirrors the `artifact` command). */
export interface ThemeEquipmentArtifactPayload {
  readonly contentType: string;
  readonly base64: string;
}

/**
 * Build an in-process, warm-store reader for the read-only `artifact` command.
 *
 * The canvas otherwise fetches every preview image by spawning a fresh `node`
 * process that loads the entire bundled CLI — including `@azure/storage-blob` —
 * just to run one `store.get`. Measured live, that fixed cost is ~2.5-5s per
 * image on a 3.6 KB PNG: pure process + module-load overhead, not byte transfer
 * or a cache miss. Constructing the RunStore once and reusing it across reads
 * collapses each subsequent read to a warm disk-cache hit.
 *
 * It is read-only by construction — it only ever issues `artifact` commands,
 * which never mutate durable state — so it deliberately skips the per-command
 * process isolation the mutation path still relies on. It shares the same disk
 * cache the child processes already populate (`createRunStore` resolves a fixed
 * cache dir keyed by the non-secret store identity), so even the first
 * in-process read is a warm hit.
 */
export function createThemeEquipmentArtifactReader(options: {
  readonly repoRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): {
  read(setId: string, itemId: string, artifactId: string): Promise<ThemeEquipmentArtifactPayload>;
} {
  const store = createRunStore({ repoRoot: options.repoRoot, env: options.env ?? process.env });
  const deps: ThemeEquipmentReviewCliDeps = {
    store,
    now: () => new Date(),
    repoRoot: options.repoRoot,
  };
  return {
    async read(setId, itemId, artifactId) {
      const result = await executeThemeEquipmentReviewCommand(
        { action: 'artifact', setId, itemId, artifactId },
        deps,
      );
      const contentType = result.contentType;
      const base64 = result.base64;
      if (typeof contentType !== 'string' || typeof base64 !== 'string') {
        throw new Error('Artifact command did not return a previewable payload.');
      }
      return { contentType, base64 };
    },
  };
}

/**
 * Default plan publisher: pushes the authored plan to the long-lived
 * `assets/plans` branch via the GitHub Contents API so every workspace and the
 * `init` workflow read the same authoritative copy.
 *
 * Concurrency safety, in order of the checks below:
 *  - Branch bootstrap: a 404 on the branch creates it from the default-branch
 *    tip; a 422 (a racing save created it first) is reconciled by re-reading.
 *  - Overwrite: the *remote* file existence is authoritative — a remote plan
 *    with `overwrite !== true` is a hard stop even if the local check passed.
 *  - Compare-and-swap: the PUT carries the remote blob `sha`, so a concurrent
 *    same-file write makes exactly one PUT win.
 *  - Ambiguous failure: if the PUT times out or the connection drops, the push
 *    may still have landed; the remote blob is re-read and compared byte-for-
 *    byte before the failure is believed, so a slow-but-successful push is not
 *    double-reported as an error (and then rolled back) by the caller.
 *
 * Every `gh` call is bounded, and the whole sequence shares a wall-clock
 * deadline shorter than the bridge's command timeout so the caller always
 * regains control to verify or roll back (never stranded mid-PUT).
 *
 * Auth is ambient (`gh`'s own credential or `GH_TOKEN`); `{owner}`/`{repo}`
 * are filled by `gh` from the current repository's remote.
 */
export function createGhPlanPublisher(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: {
    /** Injectable low-level `gh api` runner (defaults to the real bounded call). */
    readonly runGh?: (args: readonly string[], deadline: number) => Promise<GhApiResult>;
    /** Override the publish budget (ms from `now()`); defaults to the process-start anchor. */
    readonly deadlineMs?: number;
    /** Clock source, injectable for deterministic tests. */
    readonly now?: () => number;
  } = {},
): ThemeSetPlanPublisher {
  const now = options.now ?? Date.now;
  const runGh =
    options.runGh ?? ((args: readonly string[], deadline: number) => runGhApi(args, env, deadline));
  return async (input) => {
    // Anchor the deadline at process start (not here) so time already spent by
    // the caller — e.g. savePlan's durable-state probes — counts against the
    // same budget the bridge times out on. When an explicit deadlineMs is given
    // (tests), measure it from now().
    const deadline =
      options.deadlineMs !== undefined
        ? now() + options.deadlineMs
        : PROCESS_START_MS + PUBLISH_DEADLINE_MS;
    const gh = (args: readonly string[], callDeadline: number = deadline) =>
      runGh(args, callDeadline);

    const branchProbe = await gh([`repos/{owner}/{repo}/branches/${PLANS_BRANCH}`]);
    if (branchProbe.status === 404) {
      await ensurePlansBranch(gh);
    } else if (!branchProbe.ok) {
      throw planPublishFailure(branchProbe);
    }

    const encodedPath = input.planPath.split('/').map(encodeURIComponent).join('/');
    const contentsPath = `repos/{owner}/{repo}/contents/${encodedPath}`;

    const remoteProbe = await gh([`${contentsPath}?ref=${PLANS_BRANCH}`]);
    let remoteSha: string | undefined;
    if (remoteProbe.ok) {
      const parsed = safeJson(remoteProbe.stdout) as
        | { sha?: unknown; html_url?: unknown }
        | undefined;
      remoteSha = typeof parsed?.sha === 'string' ? parsed.sha : undefined;
      if (!input.overwrite) {
        // The shared copy already exists. If it is byte-for-byte this plan, the
        // write is a no-op — treat it as idempotent success so a retry of a
        // partially-landed publish completes without escalating to an overwrite
        // that could clobber a *different* maintainer's plan under the same id.
        // Only genuinely differing content is refused pending explicit overwrite.
        if (decodeContentsPayload(parsed) === input.content) {
          return {
            branch: PLANS_BRANCH,
            commit: '',
            url: typeof parsed?.html_url === 'string' ? parsed.html_url : '',
          };
        }
        throw new Error(
          `${input.planPath} already exists on ${PLANS_BRANCH}; pass overwrite to replace the shared copy.`,
        );
      }
    } else if (remoteProbe.status !== 404) {
      throw planPublishFailure(remoteProbe);
    }

    const putArgs = [
      '--method',
      'PUT',
      contentsPath,
      '-f',
      `message=chore(theme-equipment): save plan ${input.setId} (${input.displayName})`,
      '-f',
      `content=${Buffer.from(input.content, 'utf8').toString('base64')}`,
      '-f',
      `branch=${PLANS_BRANCH}`,
    ];
    if (remoteSha) putArgs.push('-f', `sha=${remoteSha}`);

    // Hold back a verification window: the PUT may not spend the whole budget,
    // so the post-PUT GET below can always run and confirm whether an ambiguous
    // PUT actually landed instead of blindly reporting failure and rolling back.
    const put = await gh(putArgs, deadline - PUBLISH_VERIFY_RESERVE_MS);
    if (put.ok) {
      const parsed = safeJson(put.stdout) as
        | { commit?: { sha?: unknown; html_url?: unknown }; content?: { html_url?: unknown } }
        | undefined;
      return {
        branch: PLANS_BRANCH,
        commit: typeof parsed?.commit?.sha === 'string' ? parsed.commit.sha : '',
        url:
          typeof parsed?.content?.html_url === 'string'
            ? parsed.content.html_url
            : typeof parsed?.commit?.html_url === 'string'
              ? parsed.commit.html_url
              : '',
      };
    }

    // Ambiguous failure: the PUT may have landed. Verify the remote blob before
    // believing the error, so a slow-but-successful push is reported as success.
    // The commit sha is not recoverable from a Contents GET, so it is returned
    // empty and the canvas renders "commit pending".
    const verify = await gh([`${contentsPath}?ref=${PLANS_BRANCH}`]);
    if (verify.ok) {
      const parsed = safeJson(verify.stdout) as { html_url?: unknown } | undefined;
      if (decodeContentsPayload(parsed) === input.content) {
        return {
          branch: PLANS_BRANCH,
          commit: '',
          url: typeof parsed?.html_url === 'string' ? parsed.html_url : '',
        };
      }
    }
    throw planPublishFailure(put);
  };
}

interface GhApiResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly errorMessage: string;
  /**
   * True only for a genuine transport-level transient that carries no HTTP
   * status: the child was killed by our per-call timeout / publish deadline, or
   * the connection dropped mid-flight. It distinguishes a retryable outage from
   * a definitive *local* fault (a missing `gh` binary, an unauthenticated CLI
   * preflight, a bad argument) which also lacks an HTTP status but must roll the
   * plan back rather than sit pending forever. Undefined is treated as
   * non-transient (definitive).
   */
  readonly transient?: boolean;
}

/** Wrap a failed `gh api` result as a classified, retry-aware publisher error. */
function planPublishFailure(result: GhApiResult): PlanPublishError {
  return new PlanPublishError(result.errorMessage, {
    retryable: isRetryableGhFailure(result),
    status: result.status,
  });
}

/** Run one bounded `gh api` call, surfacing the HTTP status rather than throwing. */
/**
 * Recognized transport-failure signatures in `gh`/child-process stderr. Covers
 * both libc/Node errno spellings (ECONNRESET, ETIMEDOUT, …) and the Go/Windows
 * `net` diagnostics `gh` prints on Windows (`proxyconnect tcp`, `connectex`,
 * `actively refused`, `no such host`, `dial tcp`). Used to decide whether a
 * null-HTTP-status `gh` failure is a retryable network blip (kept pending) or a
 * definitive local fault (rolled back).
 */
const GH_TRANSPORT_ERROR_RE =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network is unreachable|i\/o timeout|TLS handshake|connection reset|timed out|proxyconnect tcp|connectex|actively refused|no such host|dial tcp/i;

/**
 * Classify a failed `gh` invocation as a retryable transient. A transient is a
 * null-HTTP-status failure that is a genuine transport problem: the child was
 * killed by our own deadline (`killed`/SIGTERM), or stderr matches a recognized
 * network-layer error. ENOENT (no `gh` binary), auth-preflight failures, and bad
 * arguments are definitive local faults and return false.
 */
export function classifyGhFailureTransient(fault: {
  status: number | null;
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stderr?: string;
}): boolean {
  if (fault.status !== null) return false;
  if (fault.killed === true || fault.signal === 'SIGTERM') return true;
  if (fault.code === 'ENOENT') return false;
  return GH_TRANSPORT_ERROR_RE.test(fault.stderr ?? '');
}

async function runGhApi(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deadline: number,
): Promise<GhApiResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return {
      ok: false,
      status: null,
      stdout: '',
      errorMessage: 'Plan publish deadline exceeded before completing the GitHub API calls.',
      transient: true,
    };
  }
  try {
    const { stdout } = await execFileAsync('gh', ['api', ...args], {
      env: { ...env },
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: Math.min(PUBLISH_PER_CALL_MS, remaining),
    });
    return { ok: true, status: 200, stdout, errorMessage: '' };
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown })?.stderr === 'string'
        ? ((error as { stderr: string }).stderr as string)
        : '';
    const statusMatch = /HTTP (\d{3})/.exec(stderr);
    const status = statusMatch ? Number(statusMatch[1]) : null;
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    const transient = classifyGhFailureTransient({
      status,
      code: (error as { code?: unknown }).code,
      killed: (error as { killed?: unknown }).killed,
      signal: (error as { signal?: unknown }).signal,
      stderr,
    });
    return {
      ok: false,
      status,
      stdout: '',
      errorMessage: `gh api ${args[0] ?? ''} failed: ${message}`,
      transient,
    };
  }
}

/** Create `assets/plans` from the default-branch tip, reconciling a create race. */
async function ensurePlansBranch(
  gh: (args: readonly string[]) => Promise<GhApiResult>,
): Promise<void> {
  const repoProbe = await gh(['repos/{owner}/{repo}']);
  if (!repoProbe.ok) throw planPublishFailure(repoProbe);
  const defaultBranch =
    typeof (safeJson(repoProbe.stdout) as { default_branch?: unknown } | undefined)
      ?.default_branch === 'string'
      ? ((safeJson(repoProbe.stdout) as { default_branch: string }).default_branch as string)
      : '';
  if (!defaultBranch) throw new Error('Could not resolve the default branch to seed assets/plans.');

  const refProbe = await gh([`repos/{owner}/{repo}/git/ref/heads/${defaultBranch}`]);
  if (!refProbe.ok) throw planPublishFailure(refProbe);
  const sha =
    typeof (safeJson(refProbe.stdout) as { object?: { sha?: unknown } } | undefined)?.object
      ?.sha === 'string'
      ? ((safeJson(refProbe.stdout) as { object: { sha: string } }).object.sha as string)
      : '';
  if (!sha) throw new Error('Could not resolve the default-branch sha to seed assets/plans.');

  const create = await gh([
    '--method',
    'POST',
    'repos/{owner}/{repo}/git/refs',
    '-f',
    `ref=refs/heads/${PLANS_BRANCH}`,
    '-f',
    `sha=${sha}`,
  ]);
  if (create.ok) return;
  // 422 == the ref already exists (a concurrent save won the create). Confirm
  // it now exists and continue; anything else is a real failure.
  if (create.status === 422) {
    const recheck = await gh([`repos/{owner}/{repo}/branches/${PLANS_BRANCH}`]);
    if (recheck.ok) return;
    // The branch very likely exists but the confirming read failed. Classify the
    // recheck so a transient outage stays retryable (keeps the plan pending)
    // instead of being reported as a definitive failure that rolls it back.
    throw planPublishFailure(recheck);
  }
  throw planPublishFailure(create);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Decode a GitHub Contents API payload's base64 `content` field to UTF-8. */
function decodeContentsPayload(parsed: unknown): string | null {
  const record = parsed as { content?: unknown; encoding?: unknown } | undefined;
  if (!record || typeof record.content !== 'string' || record.encoding !== 'base64') return null;
  return Buffer.from(record.content.replace(/\n/g, ''), 'base64').toString('utf8');
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
      publishPlan: createGhPlanPublisher(process.env),
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
