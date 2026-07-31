/**
 * Model-proposed equipment rosters for a new theme.
 *
 * Authoring a themed set used to mean hand-writing every item of a
 * ~20-item plan JSON. That is exactly the friction the forge exists to
 * remove, so this module turns a short human brief (set id, display
 * name, and a human-authored design language) into a candidate
 * {@link ThemeEquipmentSetPlan} that a human then reviews and edits.
 *
 * Two invariants matter more than anything else here:
 *
 *  1. **The deterministic coverage gate is the only judge.** Every
 *     candidate is run through `buildThemeEquipmentSetStateFromPlan`,
 *     the same expansion the real pipeline uses, so a proposal that
 *     misses the required distinct weapon types or non-hand slots is
 *     rejected by the production validator rather than by a bespoke
 *     check that could drift. The thresholds are imported, never
 *     re-declared and never relaxed — a roster the model cannot get to
 *     coverage is a hard failure, not a downgraded target.
 *
 *  2. **Identity and design language are human-authored.** The model
 *     only ever proposes the item list. `id`, `displayName`, and
 *     `themeDesignLanguage` are overwritten with the caller's values
 *     before validation, so a model can neither rename a set nor
 *     invent the style contract that every downstream brief inherits.
 */

import {
  NON_HAND_EQUIPMENT_SLOT_IDS,
  THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS,
  THEME_EQUIPMENT_SET_MIN_WEAPON_TYPES,
  buildThemeEquipmentSetStateFromPlan,
  themeEquipmentSetPlanSchema,
  type ThemeEquipmentSetPlan,
} from './theme-equipment-set.js';
import { _MIRROR_SLOT_PAIRS_FOR_TESTS } from '../../src/shared/equipment-slots.js';

/** Human-readable "leftArm+rightArm" list for the roster prompt, from the canonical pairs. */
const MIRROR_PAIR_PROMPT_LIST = _MIRROR_SLOT_PAIRS_FOR_TESTS
  .map(([a, b]) => `${a}+${b}`)
  .join(', ');

/**
 * Minimal chat surface this module needs: a single structured-JSON
 * completion. Injectable so tests never touch a network provider.
 */
export type ThemeRosterChatCaller = (request: {
  readonly system: string;
  readonly user: string;
}) => Promise<string>;

export interface SynthesizeThemeRosterRequest {
  /** Stable kebab set id — also the plan filename stem. */
  readonly setId: string;
  readonly displayName: string;
  /** Human-authored style contract. Never model-derived. */
  readonly themeDesignLanguage: string;
  /** Optional free-text steer ("lean 1920s Chicago rather than NYC"). */
  readonly notes?: string;
}

export interface SynthesizeThemeRosterDeps {
  readonly chat: ThemeRosterChatCaller;
  /**
   * Extra attempts allowed after the first, each fed the previous
   * deterministic failure. Defaults to 2 (so 3 calls at most).
   */
  readonly maxRepairAttempts?: number;
}

export interface SynthesizeThemeRosterResult {
  readonly plan: ThemeEquipmentSetPlan;
  /** Number of model calls made, including the successful one. */
  readonly attempts: number;
  /** Deterministic rejections that triggered a repair, oldest first. */
  readonly repairs: readonly string[];
}

export class ThemeRosterSynthError extends Error {
  readonly attempts: number;
  readonly failures: readonly string[];

  constructor(attempts: number, failures: readonly string[]) {
    super(
      `Roster synthesis failed after ${attempts} attempt(s); the proposal never satisfied the deterministic coverage gate. ` +
        `Last failure: ${failures.at(-1) ?? 'unknown'}`,
    );
    this.name = 'ThemeRosterSynthError';
    this.attempts = attempts;
    this.failures = failures;
  }
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

export async function synthesizeThemeRoster(
  request: SynthesizeThemeRosterRequest,
  deps: SynthesizeThemeRosterDeps,
): Promise<SynthesizeThemeRosterResult> {
  const maxRepairAttempts = deps.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new TypeError('maxRepairAttempts must be a non-negative integer');
  }

  const failures: string[] = [];
  const totalAttempts = maxRepairAttempts + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const raw = await deps.chat({
      system: buildRosterSystemPrompt(),
      user: buildRosterUserPrompt(request, failures.at(-1)),
    });

    try {
      const plan = validateRosterProposal(raw, request);
      return { plan, attempts: attempt, repairs: [...failures] };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new ThemeRosterSynthError(totalAttempts, failures);
}

/**
 * Parse a model proposal, force the human-authored identity fields back
 * on to it, and run it through the production plan expansion so schema,
 * duplicate-id, unknown-slot, and coverage failures all surface here.
 *
 * Exported for the roster editor: the canvas re-validates a
 * human-edited roster through exactly this path before saving.
 */
export function validateRosterProposal(
  raw: string,
  request: SynthesizeThemeRosterRequest,
): ThemeEquipmentSetPlan {
  const parsed = parseJsonObject(raw);
  const candidate = {
    ...parsed,
    id: request.setId,
    displayName: request.displayName,
    themeDesignLanguage: request.themeDesignLanguage,
  };

  const plan = themeEquipmentSetPlanSchema.parse(candidate);
  // Dry-run the real expansion: it is the only authority on coverage,
  // duplicate ids across the weapon/equipment lists, and slot validity.
  buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: new Date(0).toISOString() });
  return plan;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = stripCodeFence(raw).trim();
  if (text.length === 0) throw new Error('model returned an empty response');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `model response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('model response was not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function stripCodeFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  return fenced?.[1] ?? raw;
}

export function buildRosterSystemPrompt(): string {
  return [
    'You design equipment rosters for a 2D pixel-art dungeon crawler.',
    'You propose WHICH items a themed equipment set should contain. You do not write art briefs, stats, or lore.',
    '',
    'Respond with a single JSON object and nothing else:',
    '{"weapons":[{"id":"kebab-case","displayName":"Title Case","weaponType":"lowercase-category"}],',
    ' "equipment":[{"id":"kebab-case","displayName":"Title Case","slots":["slotId"]}]}',
    '',
    'Rules:',
    '- Every id is lowercase kebab-case and unique across BOTH lists.',
    `- Cover at least ${THEME_EQUIPMENT_SET_MIN_WEAPON_TYPES} DISTINCT weaponType values.`,
    '- weaponType is a broad weapon category (sword, axe, bow, spear, dagger, hammer, ...), not the item name.',
    `- Cover at least ${THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS} DISTINCT equipment slots.`,
    `- Valid slot ids (use only these): ${NON_HAND_EQUIPMENT_SLOT_IDS.join(', ')}.`,
    '- Each equipment entry lists the slots that ONE item occupies.',
    `- Mirror-pair slots MUST be a single unified item that lists BOTH sides — never a left item and a right item. Pairs: ${MIRROR_PAIR_PROMPT_LIST}. e.g. one "Bracers" with slots ["leftWrist","rightWrist"], one ring with slots ["ringLeft","ringRight"], one arm item with slots ["leftArm","rightArm"].`,
    '- Every other item occupies exactly one slot.',
    '- Prefer plain, archetypal gear for the theme. These are BASE items that later get recoloured and resized into variants, so avoid one-off named artifacts.',
    '- Names must be evocative of the theme but readable at 32px: concrete objects, not abstractions.',
  ].join('\n');
}

export function buildRosterUserPrompt(
  request: SynthesizeThemeRosterRequest,
  previousFailure?: string,
): string {
  const lines = [
    `Theme: ${request.displayName}`,
    '',
    'Design language (authoritative — every item must plausibly belong to this world):',
    request.themeDesignLanguage,
  ];
  if (request.notes && request.notes.trim().length > 0) {
    lines.push('', 'Additional direction:', request.notes.trim());
  }
  lines.push(
    '',
    `Propose the roster. Aim for ${THEME_EQUIPMENT_SET_MIN_WEAPON_TYPES + 1} weapons across that many distinct weapon types, and cover the equipment slots — one item per slot, except mirror pairs (${MIRROR_PAIR_PROMPT_LIST}) which are each a single unified item listing both sides.`,
  );
  if (previousFailure) {
    lines.push(
      '',
      'Your previous proposal was REJECTED by a deterministic validator with this error:',
      previousFailure,
      'Fix that specific problem. Do not lower coverage to make it pass.',
    );
  }
  return lines.join('\n');
}
