import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SLOT_REGISTRY } from '../../src/shared/equipment-slots.js';
import { StoreConditionalWriteError, StoreNotFoundError, type RunStore } from './store/types.js';

export const THEME_EQUIPMENT_SET_SCHEMA_VERSION = 1;
export const THEME_EQUIPMENT_SET_MAX_ITEMS = 32;
export const THEME_EQUIPMENT_SET_MIN_WEAPON_TYPES = 5;

export const THEME_EQUIPMENT_SET_PHASES = [
  'roster',
  'briefs',
  'sprite-sheets',
  'variant-approval',
  'complete',
] as const;

export const THEME_EQUIPMENT_SET_REVIEW_PHASES = [
  'roster',
  'briefs',
  'sprite-sheets',
  'variant-approval',
] as const;

export type ThemeEquipmentSetPhase = (typeof THEME_EQUIPMENT_SET_PHASES)[number];
export type ThemeEquipmentSetReviewPhase = (typeof THEME_EQUIPMENT_SET_REVIEW_PHASES)[number];

export const NON_HAND_EQUIPMENT_SLOT_IDS = SLOT_REGISTRY.map((slot) => slot.id).filter(
  (id) => id !== 'mainHand' && id !== 'offHand',
);
export const THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS = Math.ceil(
  (NON_HAND_EQUIPMENT_SLOT_IDS.length * 2) / 3,
);

const VALID_NON_HAND_SLOT_IDS = new Set(NON_HAND_EQUIPMENT_SLOT_IDS);
const REVIEW_PHASE_SET = new Set<string>(THEME_EQUIPMENT_SET_REVIEW_PHASES);
const KEBAB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const kebabIdSchema = z
  .string()
  .trim()
  .regex(KEBAB_ID_PATTERN, 'must be a stable lowercase kebab id');

const reviewSchema = z
  .object({
    verdict: z.enum(['up', 'down']).nullable(),
    feedback: z.string().trim().min(1).optional(),
  })
  .strict();

const artifactEvidenceSchema = z
  .object({
    id: kebabIdSchema,
    kind: z.string().trim().min(1),
    uri: z.string().trim().min(1),
    summary: z.string().trim().min(1).optional(),
    provenance: z.string().trim().min(1).optional(),
    /** Exact generated brief/run identity used by atomic publication artifacts. */
    briefId: z.string().trim().min(1).optional(),
    /** Exact generated run identity; paired with briefId for durable artifact lookup. */
    runId: z.string().trim().min(1).optional(),
    /** Exact source-run variant index; it is not necessarily contiguous or zero-based per item. */
    variantIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

const itemPhaseStateSchema = z
  .object({
    artifacts: z.array(artifactEvidenceSchema),
    evidence: z.array(artifactEvidenceSchema),
    review: reviewSchema,
  })
  .strict();

const collectionJudgeResultSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    rationale: z.string().trim().min(1),
    provenance: z.string().trim().min(1),
  })
  .strict();

const phaseSetReviewSchema = z
  .object({
    humanReview: reviewSchema,
    collectionJudge: collectionJudgeResultSchema.nullable(),
  })
  .strict();

const themeEquipmentSetPublicationSchema = z
  .object({
    status: z.enum(['held', 'published']),
    publishedAt: z.string().trim().min(1).nullable(),
    queueCommit: z.string().trim().min(1).nullable(),
  })
  .strict();

const itemPhaseRecordSchema = z
  .object({
    roster: itemPhaseStateSchema,
    briefs: itemPhaseStateSchema,
    'sprite-sheets': itemPhaseStateSchema,
    'variant-approval': itemPhaseStateSchema,
  })
  .strict();

const setPhaseRecordSchema = z
  .object({
    roster: phaseSetReviewSchema,
    briefs: phaseSetReviewSchema,
    'sprite-sheets': phaseSetReviewSchema,
    'variant-approval': phaseSetReviewSchema,
  })
  .strict();

const weaponItemSchema = z
  .object({
    id: kebabIdSchema,
    displayName: z.string().trim().min(1),
    kind: z.literal('weapon'),
    weaponType: z.string().trim().min(1),
    revision: z.number().int().min(0),
    revisionStatus: z.enum(['open', 'frozen']),
    frozenPhases: z.array(z.enum(THEME_EQUIPMENT_SET_REVIEW_PHASES)),
    phases: itemPhaseRecordSchema,
  })
  .strict();

const equipmentItemSchema = z
  .object({
    id: kebabIdSchema,
    displayName: z.string().trim().min(1),
    kind: z.literal('equipment'),
    slots: z.array(z.string().trim().min(1)).min(1),
    revision: z.number().int().min(0),
    revisionStatus: z.enum(['open', 'frozen']),
    frozenPhases: z.array(z.enum(THEME_EQUIPMENT_SET_REVIEW_PHASES)),
    phases: itemPhaseRecordSchema,
  })
  .strict()
  .superRefine((item, ctx) => {
    const seen = new Set<string>();
    for (const slot of item.slots) {
      if (!VALID_NON_HAND_SLOT_IDS.has(slot)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots'],
          message: `unknown or hand equipment slot "${slot}"`,
        });
      }
      if (seen.has(slot)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots'],
          message: `duplicate slot "${slot}"`,
        });
      }
      seen.add(slot);
    }
  });

export const themeEquipmentSetStateSchema = z
  .object({
    schemaVersion: z.literal(THEME_EQUIPMENT_SET_SCHEMA_VERSION),
    id: kebabIdSchema,
    displayName: z.string().trim().min(1),
    themeDesignLanguage: z.string().trim().min(1),
    phase: z.enum(THEME_EQUIPMENT_SET_PHASES),
    items: z
      .array(z.discriminatedUnion('kind', [weaponItemSchema, equipmentItemSchema]))
      .max(THEME_EQUIPMENT_SET_MAX_ITEMS),
    phases: setPhaseRecordSchema,
    // `.default()` keeps every pre-existing state fixture (and RunStore
    // payload written before publication tracking existed) parseable: the
    // key is filled in with a fresh "held" record when absent, rather than
    // requiring every caller to migrate stored JSON. The factory (not a
    // literal) guarantees each parse gets its own object, never a shared
    // reference across states.
    publication: themeEquipmentSetPublicationSchema.default(() =>
      emptyThemeEquipmentSetPublication(),
    ),
    stateRevision: z.number().int().min(0),
    updatedAt: z.string().trim().min(1),
  })
  .strict()
  .superRefine((state, ctx) => {
    const seen = new Set<string>();
    for (const item of state.items) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items'],
          message: `duplicate item id "${item.id}"`,
        });
      }
      seen.add(item.id);
    }
  });

export type ThemeEquipmentReview = z.infer<typeof reviewSchema>;
export type ThemeEquipmentArtifactEvidence = z.infer<typeof artifactEvidenceSchema>;
export type ThemeEquipmentItemPhaseState = z.infer<typeof itemPhaseStateSchema>;
export type ThemeEquipmentCollectionJudgeResult = z.infer<typeof collectionJudgeResultSchema>;
export type ThemeEquipmentSetPhaseReview = z.infer<typeof phaseSetReviewSchema>;
export type ThemeEquipmentSetPublication = z.infer<typeof themeEquipmentSetPublicationSchema>;
export type ThemeEquipmentSetItem =
  | z.infer<typeof weaponItemSchema>
  | z.infer<typeof equipmentItemSchema>;
export type ThemeEquipmentSetState = z.infer<typeof themeEquipmentSetStateSchema>;

/** Artifact `kind` marking a variant-approval artifact as the human-approved pick. */
export const THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND = 'approved-variant';
/** Publication requires each item to carry at least this many approved variants. */
export const THEME_EQUIPMENT_MIN_APPROVED_VARIANTS = 1;
/** Publication requires each item to carry at most this many approved variants. */
export const THEME_EQUIPMENT_MAX_APPROVED_VARIANTS = 3;

export interface ThemeSetGateReason {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

export interface ThemeSetAdvanceCheck {
  readonly canAdvance: boolean;
  readonly fromPhase: ThemeEquipmentSetPhase | null;
  readonly toPhase: ThemeEquipmentSetPhase | null;
  readonly reasons: readonly ThemeSetGateReason[];
}

export type ThemeSetMutationResult =
  | {
      readonly ok: true;
      readonly state: ThemeEquipmentSetState;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly ThemeSetGateReason[];
    };

export class ThemeEquipmentSetValidationError extends Error {
  override readonly name = 'ThemeEquipmentSetValidationError';

  constructor(readonly reasons: readonly ThemeSetGateReason[]) {
    super(reasons.map((reason) => reason.message).join('; '));
  }
}

export class ThemeEquipmentSetRevisionConflictError extends Error {
  override readonly name = 'ThemeEquipmentSetRevisionConflictError';

  constructor(
    readonly key: string,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(
      `Theme equipment set ${key} revision conflict: expected ${expectedRevision}, found ${actualRevision}`,
    );
  }
}

export function emptyThemeEquipmentReview(): ThemeEquipmentReview {
  return { verdict: null };
}

export function emptyThemeEquipmentItemPhaseState(): ThemeEquipmentItemPhaseState {
  return { artifacts: [], evidence: [], review: emptyThemeEquipmentReview() };
}

export function emptyThemeEquipmentSetPhaseReview(): ThemeEquipmentSetPhaseReview {
  return { humanReview: emptyThemeEquipmentReview(), collectionJudge: null };
}

export function emptyThemeEquipmentItemPhases(): ThemeEquipmentSetItem['phases'] {
  return {
    roster: emptyThemeEquipmentItemPhaseState(),
    briefs: emptyThemeEquipmentItemPhaseState(),
    'sprite-sheets': emptyThemeEquipmentItemPhaseState(),
    'variant-approval': emptyThemeEquipmentItemPhaseState(),
  };
}

export function emptyThemeEquipmentSetPhases(): ThemeEquipmentSetState['phases'] {
  return {
    roster: emptyThemeEquipmentSetPhaseReview(),
    briefs: emptyThemeEquipmentSetPhaseReview(),
    'sprite-sheets': emptyThemeEquipmentSetPhaseReview(),
    'variant-approval': emptyThemeEquipmentSetPhaseReview(),
  };
}

export function emptyThemeEquipmentSetPublication(): ThemeEquipmentSetPublication {
  return { status: 'held', publishedAt: null, queueCommit: null };
}

/**
 * True when `item` is up-reviewed or frozen for `phase` and must be
 * preserved as-is: no new phase artifacts/evidence may be recorded for it,
 * and pipeline runners must skip re-executing it.
 */
export function isThemeSetItemResolvedForPhase(
  item: ThemeEquipmentSetItem,
  phase: ThemeEquipmentSetReviewPhase,
): boolean {
  return (
    item.revisionStatus === 'frozen' ||
    item.frozenPhases.includes(phase) ||
    item.phases[phase].review.verdict === 'up'
  );
}

/**
 * True when the pipeline has already produced at least one artifact for `item`
 * in `phase`. Distinguishes a never-generated item (a run "generates" it) from
 * one that has output but is unresolved (a run "regenerates" it). Purely
 * cosmetic — drives only the Run-button wording, never eligibility or gating.
 */
export function themeSetItemHasPhaseOutput(
  item: ThemeEquipmentSetItem,
  phase: ThemeEquipmentSetReviewPhase,
): boolean {
  return item.phases[phase].artifacts.length > 0;
}

export function themeEquipmentSetStateKey(setId: string): string {
  if (!KEBAB_ID_PATTERN.test(setId)) {
    throw new ThemeEquipmentSetValidationError([
      {
        code: 'invalid-set-id',
        message: `Invalid theme equipment set id "${setId}"`,
        path: ['id'],
      },
    ]);
  }
  return `theme-sets/${setId}/state.json`;
}

export function validateThemeEquipmentSetCoverage(
  state: ThemeEquipmentSetState,
): readonly ThemeSetGateReason[] {
  const weaponTypes = new Set<string>();
  const coveredSlots = new Set<string>();

  for (const item of state.items) {
    if (item.kind === 'weapon') {
      const weaponType = item.weaponType.trim();
      if (weaponType.length > 0) {
        weaponTypes.add(weaponType);
      }
    } else {
      for (const slot of item.slots) {
        if (VALID_NON_HAND_SLOT_IDS.has(slot)) {
          coveredSlots.add(slot);
        }
      }
    }
  }

  const reasons: ThemeSetGateReason[] = [];
  if (weaponTypes.size < THEME_EQUIPMENT_SET_MIN_WEAPON_TYPES) {
    reasons.push({
      code: 'coverage-weapon-types',
      message: `Theme set covers ${weaponTypes.size}/${THEME_EQUIPMENT_SET_MIN_WEAPON_TYPES} required distinct non-empty weapon types`,
      path: ['items'],
    });
  }
  if (coveredSlots.size < THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS) {
    reasons.push({
      code: 'coverage-non-hand-slots',
      message: `Theme set covers ${coveredSlots.size}/${THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS} required non-hand equipment slots`,
      path: ['items'],
    });
  }
  return reasons;
}

export function parseThemeEquipmentSetState(input: unknown): ThemeEquipmentSetState {
  const state = themeEquipmentSetStateSchema.parse(input);
  const coverageReasons = validateThemeEquipmentSetCoverage(state);
  if (coverageReasons.length > 0) {
    throw new ThemeEquipmentSetValidationError(coverageReasons);
  }
  return state;
}

export function canAdvanceThemeSet(input: unknown): ThemeSetAdvanceCheck {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      canAdvance: false,
      fromPhase: null,
      toPhase: null,
      reasons: zodIssuesToGateReasons(parsed.error.issues),
    };
  }

  const state = parsed.data;
  const toPhase = nextThemeEquipmentSetPhase(state.phase);
  const reasons: ThemeSetGateReason[] = [...validateThemeEquipmentSetCoverage(state)];

  if (toPhase === null) {
    reasons.push({
      code: 'phase-complete',
      message: 'Theme equipment set is already complete',
      path: ['phase'],
    });
    return { canAdvance: false, fromPhase: state.phase, toPhase: null, reasons };
  }

  if (!isReviewPhase(state.phase)) {
    reasons.push({
      code: 'invalid-phase',
      message: `Theme equipment set cannot advance from phase "${state.phase}"`,
      path: ['phase'],
    });
    return { canAdvance: false, fromPhase: state.phase, toPhase, reasons };
  }

  for (const item of state.items) {
    const review = item.phases[state.phase].review;
    if (review.verdict !== 'up') {
      reasons.push({
        code: 'item-review-not-up',
        message: `Item "${item.id}" has not received an up review for phase "${state.phase}"`,
        path: ['items', item.id, 'phases', state.phase, 'review'],
      });
    }
  }

  const phaseReview = state.phases[state.phase];
  if (phaseReview.humanReview.verdict !== 'up') {
    reasons.push({
      code: 'set-review-not-up',
      message: `Set-level human review is not up for phase "${state.phase}"`,
      path: ['phases', state.phase, 'humanReview'],
    });
  }
  if (phaseReview.collectionJudge === null) {
    reasons.push({
      code: 'collection-judge-missing',
      message: `Collection judge score is missing for phase "${state.phase}"`,
      path: ['phases', state.phase, 'collectionJudge'],
    });
  } else if (phaseReview.collectionJudge.score < 3) {
    reasons.push({
      code: 'collection-judge-low-score',
      message: `Collection judge score ${phaseReview.collectionJudge.score}/5 is below the required 3/5 for phase "${state.phase}"`,
      path: ['phases', state.phase, 'collectionJudge', 'score'],
    });
  }

  return { canAdvance: reasons.length === 0, fromPhase: state.phase, toPhase, reasons };
}

export function advanceThemeSetPhase(input: unknown): ThemeSetMutationResult {
  const check = canAdvanceThemeSet(input);
  if (!check.canAdvance) {
    return { ok: false, reasons: check.reasons };
  }
  const state = parseThemeEquipmentSetState(input);
  if (!isReviewPhase(state.phase) || check.toPhase === null) {
    return {
      ok: false,
      reasons: [
        {
          code: 'invalid-transition',
          message: `Cannot advance from phase "${state.phase}"`,
          path: ['phase'],
        },
      ],
    };
  }

  const frozenPhase = state.phase;
  const nextPhase = check.toPhase;
  const nextState: ThemeEquipmentSetState = {
    ...state,
    phase: nextPhase,
    stateRevision: state.stateRevision + 1,
    items: state.items.map((item) => ({
      ...item,
      revisionStatus: nextPhase === 'complete' ? 'frozen' : 'open',
      frozenPhases: addFrozenPhase(item.frozenPhases, frozenPhase),
      phases:
        nextPhase !== 'complete' && isReviewPhase(nextPhase)
          ? {
              ...item.phases,
              [nextPhase]: emptyThemeEquipmentItemPhaseState(),
            }
          : { ...item.phases },
    })),
    phases:
      nextPhase !== 'complete' && isReviewPhase(nextPhase)
        ? {
            ...state.phases,
            [nextPhase]: emptyThemeEquipmentSetPhaseReview(),
          }
        : { ...state.phases },
  };

  return { ok: true, state: parseThemeEquipmentSetState(nextState) };
}

export function reviseRejectedThemeSetItem(input: unknown, itemId: string): ThemeSetMutationResult {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reasons: zodIssuesToGateReasons(parsed.error.issues),
    };
  }
  const state = parsed.data;
  const coverageReasons = validateThemeEquipmentSetCoverage(state);
  if (coverageReasons.length > 0) {
    return { ok: false, reasons: coverageReasons };
  }
  if (!isReviewPhase(state.phase)) {
    return {
      ok: false,
      reasons: [
        {
          code: 'phase-not-revisable',
          message: `Cannot revise items during phase "${state.phase}"`,
          path: ['phase'],
        },
      ],
    };
  }

  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    return {
      ok: false,
      reasons: [
        {
          code: 'item-not-found',
          message: `Theme set item "${itemId}" was not found`,
          path: ['items'],
        },
      ],
    };
  }
  if (
    item.frozenPhases.includes(state.phase) ||
    item.phases[state.phase].review.verdict !== 'down'
  ) {
    return {
      ok: false,
      reasons: [
        {
          code: 'item-not-rejected',
          message: `Only down-reviewed, unfrozen items may be revised in phase "${state.phase}"`,
          path: ['items', item.id, 'phases', state.phase, 'review'],
        },
      ],
    };
  }

  const nextState: ThemeEquipmentSetState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    items: state.items.map((candidate) =>
      candidate.id === itemId
        ? {
            ...candidate,
            revision: candidate.revision + 1,
            revisionStatus: 'open',
            phases: {
              ...candidate.phases,
              [state.phase]: emptyThemeEquipmentItemPhaseState(),
            },
          }
        : candidate,
    ),
    phases: {
      ...state.phases,
      [state.phase]: emptyThemeEquipmentSetPhaseReview(),
    },
  };

  return { ok: true, state: parseThemeEquipmentSetState(nextState) };
}

/**
 * Records (or replaces) the current-phase artifacts/evidence for one item.
 *
 * Only unresolved items (see `isThemeSetItemResolvedForPhase`) may be
 * recorded — attempting to record an up-reviewed or frozen item is a gate
 * failure, never a silent no-op, so pipeline callers cannot accidentally
 * clobber an approved item's evidence. Recording clears that item's own
 * phase review (new evidence needs a fresh look) and invalidates the
 * set-level human review AND collection judge for the current phase, since
 * both were formed against the item's previous artifacts.
 */
export function recordThemeSetItemPhaseArtifacts(
  input: unknown,
  itemId: string,
  artifacts: readonly unknown[],
  evidence: readonly unknown[],
): ThemeSetMutationResult {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsed.error.issues) };
  }
  const state = parsed.data;
  if (!isReviewPhase(state.phase)) {
    return {
      ok: false,
      reasons: [
        {
          code: 'phase-not-recordable',
          message: `Cannot record item phase artifacts during phase "${state.phase}"`,
          path: ['phase'],
        },
      ],
    };
  }

  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    return {
      ok: false,
      reasons: [
        {
          code: 'item-not-found',
          message: `Theme set item "${itemId}" was not found`,
          path: ['items'],
        },
      ],
    };
  }
  if (isThemeSetItemResolvedForPhase(item, state.phase)) {
    return {
      ok: false,
      reasons: [
        {
          code: 'item-already-resolved',
          message: `Item "${itemId}" is up-reviewed or frozen for phase "${state.phase}" and cannot be re-recorded`,
          path: ['items', item.id, 'phases', state.phase],
        },
      ],
    };
  }

  const parsedArtifacts = z.array(artifactEvidenceSchema).safeParse(artifacts);
  if (!parsedArtifacts.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsedArtifacts.error.issues) };
  }
  const parsedEvidence = z.array(artifactEvidenceSchema).safeParse(evidence);
  if (!parsedEvidence.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsedEvidence.error.issues) };
  }

  const phase = state.phase;
  const nextState: ThemeEquipmentSetState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    items: state.items.map((candidate) =>
      candidate.id === itemId
        ? {
            ...candidate,
            phases: {
              ...candidate.phases,
              [phase]: {
                artifacts: parsedArtifacts.data,
                evidence: parsedEvidence.data,
                review: emptyThemeEquipmentReview(),
              },
            },
          }
        : candidate,
    ),
    phases: {
      ...state.phases,
      [phase]: emptyThemeEquipmentSetPhaseReview(),
    },
  };

  return { ok: true, state: parseThemeEquipmentSetState(nextState) };
}

/** Required artifact `kind` for an up vote in each reviewable phase. */
const PHASE_REQUIRED_ARTIFACT_KIND: Partial<Record<ThemeEquipmentSetReviewPhase, string>> = {
  briefs: 'selected-brief',
  'sprite-sheets': 'raw-sheet',
  'variant-approval': THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
} as const;

/**
 * True when `item` cannot yet be reviewed in `phase` because its required
 * pipeline output has not been generated. Roster has no required artifact, so it
 * is reviewable immediately and never "awaits generation". This gates the review
 * thumbs in the canvas (Change 8) so the maintainer can't approve/reject an item
 * before the pipeline has produced anything to judge. Distinct from
 * `themeSetItemHasPhaseOutput` (any artifact) — this checks the REQUIRED kind, so
 * it stays aligned with `validatePhaseArtifactsForUpVote`, the up-vote authority.
 */
export function themeSetItemAwaitsGeneration(
  item: ThemeEquipmentSetItem,
  phase: ThemeEquipmentSetReviewPhase,
): boolean {
  const requiredKind = PHASE_REQUIRED_ARTIFACT_KIND[phase];
  if (!requiredKind) return false; // roster is reviewable without generated output
  return !item.phases[phase].artifacts.some((artifact) => artifact.kind === requiredKind);
}

/**
 * Returns a gate reason when the item is missing the required artifact for an
 * up vote in the given phase, or when variant-approval has the wrong count.
 * Returns `null` when everything is in order.
 */
function validatePhaseArtifactsForUpVote(
  item: ThemeEquipmentSetItem,
  phase: ThemeEquipmentSetReviewPhase,
): ThemeSetGateReason | null {
  const requiredKind = PHASE_REQUIRED_ARTIFACT_KIND[phase];
  if (!requiredKind) return null; // roster has no required visual artifact

  const matching = item.phases[phase].artifacts.filter(
    (artifact) => artifact.kind === requiredKind,
  );

  if (matching.length === 0) {
    return {
      code: 'item-missing-phase-artifact',
      message: `Cannot approve item "${item.id}" for phase "${phase}": required "${requiredKind}" artifact is absent`,
      path: ['items', item.id, 'phases', phase, 'artifacts'],
    };
  }

  if (phase === 'variant-approval') {
    if (matching.length < THEME_EQUIPMENT_MIN_APPROVED_VARIANTS) {
      return {
        code: 'approved-variant-count-low',
        message: `Item "${item.id}" has ${matching.length} approved variant(s); at least ${THEME_EQUIPMENT_MIN_APPROVED_VARIANTS} required`,
        path: ['items', item.id, 'phases', 'variant-approval', 'artifacts'],
      };
    }
    if (matching.length > THEME_EQUIPMENT_MAX_APPROVED_VARIANTS) {
      return {
        code: 'approved-variant-count-high',
        message: `Item "${item.id}" has ${matching.length} approved variant(s); at most ${THEME_EQUIPMENT_MAX_APPROVED_VARIANTS} allowed`,
        path: ['items', item.id, 'phases', 'variant-approval', 'artifacts'],
      };
    }
  }

  return null;
}

/**
 * Applies a human up/down/null verdict (with optional feedback) to one
 * item's current-phase review. An "up" verdict is what makes
 * `isThemeSetItemResolvedForPhase` treat the item as resolved/frozen for
 * this phase (see that function) — there is no separate freeze flag to
 * flip. "down" or clearing back to `null` leaves the item open for
 * `reviseRejectedThemeSetItem` / re-recording.
 *
 * Both set-level approvals were formed against the item verdicts and the
 * artifacts they signed off on. Clearing or flipping a verdict never mutates an
 * artifact (only `recordThemeSetItemPhaseArtifacts` / `applyEditedThemeSetBrief`
 * do), so a non-withdrawing change (`null→up`, `null→down`, `down→null`,
 * `down→up`, `up→up`) leaves the collection judgment valid and the set-level
 * reviews intact. Only *withdrawing* an existing approval
 * (`previousVerdict === 'up' && nextVerdict !== 'up'`) can invalidate a
 * set-level sign-off that was predicated on that item being approved, so only
 * that transition resets `phases[phase]`.
 */
export function applyThemeSetItemReview(
  input: unknown,
  itemId: string,
  review: unknown,
): ThemeSetMutationResult {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsed.error.issues) };
  }
  const state = parsed.data;
  if (!isReviewPhase(state.phase)) {
    return {
      ok: false,
      reasons: [
        {
          code: 'phase-not-reviewable',
          message: `Cannot apply item review during phase "${state.phase}"`,
          path: ['phase'],
        },
      ],
    };
  }
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    return {
      ok: false,
      reasons: [
        {
          code: 'item-not-found',
          message: `Theme set item "${itemId}" was not found`,
          path: ['items'],
        },
      ],
    };
  }
  const parsedReview = reviewSchema.safeParse(review);
  if (!parsedReview.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsedReview.error.issues) };
  }

  const phase = state.phase;

  // An 'up' verdict is only valid once the phase's required artifacts are present.
  if (parsedReview.data.verdict === 'up') {
    const artifactReason = validatePhaseArtifactsForUpVote(item, phase);
    if (artifactReason) {
      return { ok: false, reasons: [artifactReason] };
    }
  }

  const previousVerdict = item.phases[phase].review.verdict;
  const nextVerdict = parsedReview.data.verdict;
  // Only withdrawing an existing approval can invalidate a set-level sign-off
  // that was predicated on this item being up. Every other transition leaves
  // the artifacts (and therefore both set-level reviews) valid.
  const withdrawsApproval = previousVerdict === 'up' && nextVerdict !== 'up';

  const nextState: ThemeEquipmentSetState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    items: state.items.map((candidate) =>
      candidate.id === itemId
        ? {
            ...candidate,
            phases: {
              ...candidate.phases,
              [phase]: {
                ...candidate.phases[phase],
                review: parsedReview.data,
              },
            },
          }
        : candidate,
    ),
    phases: withdrawsApproval
      ? {
          ...state.phases,
          [phase]: emptyThemeEquipmentSetPhaseReview(),
        }
      : { ...state.phases },
  };

  return { ok: true, state: parseThemeEquipmentSetState(nextState) };
}

/** One item the bulk-approve action deliberately left un-approved, with why. */
export interface ThemeSetBulkApproveSkip {
  readonly id: string;
  readonly code: string;
  readonly reason: string;
}

/**
 * A read-only plan for "approve remaining" in the current phase. `count` is the
 * number of items that WOULD be up-voted, and is the single source of truth the
 * canvas label must be derived from (Change 4: the label must match the action).
 */
export interface ThemeSetBulkApprovePlan {
  /** Current phase, or `null` when the set is not in a reviewable phase. */
  readonly phase: ThemeEquipmentSetReviewPhase | null;
  /** Items with no verdict that are eligible for an up vote — the ones we approve. */
  readonly approvableIds: readonly string[];
  /** Items already up — no action needed. */
  readonly alreadyUpIds: readonly string[];
  /** Items deliberately skipped (rejected, or missing required artifacts), with reasons. */
  readonly skipped: readonly ThemeSetBulkApproveSkip[];
  /** `approvableIds.length` — the truthful count for the button label. */
  readonly count: number;
}

export type ThemeSetBulkApproveResult =
  | {
      readonly ok: true;
      readonly state: ThemeEquipmentSetState;
      /** False when there was nothing to approve; no write should happen. */
      readonly changed: boolean;
      readonly approvedIds: readonly string[];
      readonly alreadyUpIds: readonly string[];
      readonly skipped: readonly ThemeSetBulkApproveSkip[];
    }
  | {
      readonly ok: false;
      readonly reasons: readonly ThemeSetGateReason[];
    };

function computeBulkApprovePlan(state: ThemeEquipmentSetState): ThemeSetBulkApprovePlan {
  if (!isReviewPhase(state.phase)) {
    return { phase: null, approvableIds: [], alreadyUpIds: [], skipped: [], count: 0 };
  }
  const phase = state.phase;
  const approvableIds: string[] = [];
  const alreadyUpIds: string[] = [];
  const skipped: ThemeSetBulkApproveSkip[] = [];

  for (const item of state.items) {
    const verdict = item.phases[phase].review.verdict;
    if (verdict === 'up') {
      alreadyUpIds.push(item.id);
      continue;
    }
    if (verdict === 'down') {
      skipped.push({
        id: item.id,
        code: 'item-rejected',
        reason: `Item "${item.id}" is rejected; bulk approve does not override a down vote`,
      });
      continue;
    }
    // verdict === null → approve only if the phase's required artifacts are present.
    const artifactReason = validatePhaseArtifactsForUpVote(item, phase);
    if (artifactReason) {
      skipped.push({ id: item.id, code: artifactReason.code, reason: artifactReason.message });
      continue;
    }
    approvableIds.push(item.id);
  }

  return { phase, approvableIds, alreadyUpIds, skipped, count: approvableIds.length };
}

/**
 * Pure plan for "approve remaining" in the current phase. Never mutates. Used
 * both to drive the label (`count`) and to preview skips. Returns a `phase:null`
 * empty plan for non-review phases or unparseable input.
 */
export function planApproveRemaining(input: unknown): ThemeSetBulkApprovePlan {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return { phase: null, approvableIds: [], alreadyUpIds: [], skipped: [], count: 0 };
  }
  return computeBulkApprovePlan(parsed.data);
}

/**
 * Up-votes every eligible, not-yet-reviewed item in the current phase in ONE
 * mutation (one `stateRevision` bump, one compare-and-swap write by the caller).
 * Skips rejected items and items missing required artifacts, reporting each.
 * When there is nothing to approve it returns `changed:false` and the state
 * UNCHANGED (no revision bump) so the caller writes nothing. Every applied
 * transition is `null→up`, never a withdrawal, so set-level reviews are
 * preserved — consistent with `applyThemeSetItemReview`'s narrowed reset.
 */
export function approveRemainingThemeSetPhase(input: unknown): ThemeSetBulkApproveResult {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsed.error.issues) };
  }
  const state = parsed.data;
  if (!isReviewPhase(state.phase)) {
    return {
      ok: false,
      reasons: [
        {
          code: 'phase-not-reviewable',
          message: `Cannot bulk-approve during phase "${state.phase}"`,
          path: ['phase'],
        },
      ],
    };
  }

  const plan = computeBulkApprovePlan(state);
  if (plan.count === 0) {
    return {
      ok: true,
      state,
      changed: false,
      approvedIds: [],
      alreadyUpIds: plan.alreadyUpIds,
      skipped: plan.skipped,
    };
  }

  const phase = state.phase;
  const approveSet = new Set(plan.approvableIds);
  const nextState: ThemeEquipmentSetState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    items: state.items.map((candidate) =>
      approveSet.has(candidate.id)
        ? {
            ...candidate,
            phases: {
              ...candidate.phases,
              [phase]: {
                ...candidate.phases[phase],
                review: { verdict: 'up' as const },
              },
            },
          }
        : candidate,
    ),
    // All transitions are null→up (never a withdrawal) → set-level reviews stay intact.
    phases: { ...state.phases },
  };

  return {
    ok: true,
    state: parseThemeEquipmentSetState(nextState),
    changed: true,
    approvedIds: plan.approvableIds,
    alreadyUpIds: plan.alreadyUpIds,
    skipped: plan.skipped,
  };
}

/**
 * A read-only description of what a `run-phase` dispatch would do RIGHT NOW,
 * derived from the same resolution predicate the pipeline uses
 * (`isThemeSetItemResolvedForPhase`) so the canvas label can never lie about
 * the work. A run always (re)generates every currently-unresolved item and then
 * judges the whole collection exactly once (see `runThemeEquipmentSetPhase`);
 * when nothing is unresolved the run regenerates nothing and only produces the
 * collection judge — which is exactly the state that otherwise dead-ends the
 * maintainer at Advance (`collectionJudge` is required by `canAdvanceThemeSet`).
 */
export interface ThemeSetRunPhasePlan {
  /** Current phase, or `null` when the set is not in a reviewable phase. */
  readonly phase: ThemeEquipmentSetReviewPhase | null;
  /**
   * Number of unresolved items a run would generate for the FIRST time — items
   * with no phase output yet. Disjoint from `regenerateCount`.
   */
  readonly generateCount: number;
  /**
   * Number of unresolved items a run would regenerate — items that already have
   * phase output (e.g. rejected and awaiting a fresh attempt). Disjoint from
   * `generateCount`. Invariant: `generateCount + regenerateCount` equals the
   * total unresolved item count.
   */
  readonly regenerateCount: number;
  /** True when a run regenerates nothing and would only judge the collection. */
  readonly judgeOnly: boolean;
  /** True when the current phase has no collection judge yet (blocks Advance). */
  readonly collectionJudgeMissing: boolean;
}

/**
 * Pure plan for the `run-phase` control in the current phase. Never mutates.
 * Drives the Run button's truthful label and the "a run is required to produce
 * the collection judge" guidance — both derived from this one computation so the
 * label matches the work (mirrors `planApproveRemaining`). Returns a `phase:null`
 * empty plan for non-review phases or unparseable input.
 */
export function planRunPhase(input: unknown): ThemeSetRunPhasePlan {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      phase: null,
      generateCount: 0,
      regenerateCount: 0,
      judgeOnly: false,
      collectionJudgeMissing: false,
    };
  }
  const state = parsed.data;
  if (!isReviewPhase(state.phase)) {
    return {
      phase: null,
      generateCount: 0,
      regenerateCount: 0,
      judgeOnly: false,
      collectionJudgeMissing: false,
    };
  }
  const phase = state.phase;
  const unresolved = state.items.filter((item) => !isThemeSetItemResolvedForPhase(item, phase));
  const regenerateCount = unresolved.filter((item) =>
    themeSetItemHasPhaseOutput(item, phase),
  ).length;
  const generateCount = unresolved.length - regenerateCount;
  return {
    phase,
    generateCount,
    regenerateCount,
    judgeOnly: unresolved.length === 0,
    collectionJudgeMissing: state.phases[phase].collectionJudge === null,
  };
}

/**
 * (unlike a verdict change) it MUST invalidate the set-level briefs review: the
 * collection judgment and human sign-off were formed against the old brief text.
 *
 * The caller (the CLI) is responsible for the real side effect — writing the
 * validated YAML to `selectedBriefKey(state, item, item.revision + 1)` (a NEW
 * key, so a failed compare-and-swap never corrupts the live brief) — and for
 * minting the `artifact`/`evidence` records that point at it. This pure mutation
 * only rewrites state: it bumps `item.revision`, replaces the item's briefs
 * phase with the new artifact + an `up` review, and clears `phases.briefs`.
 */
export function applyEditedThemeSetBrief(
  input: unknown,
  itemId: string,
  records: { readonly artifact: unknown; readonly evidence: unknown },
): ThemeSetMutationResult {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsed.error.issues) };
  }
  const state = parsed.data;
  if (state.phase !== 'briefs') {
    return {
      ok: false,
      reasons: [
        {
          code: 'phase-not-briefs',
          message: `Brief edits are only allowed during phase "briefs" (current: "${state.phase}")`,
          path: ['phase'],
        },
      ],
    };
  }
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    return {
      ok: false,
      reasons: [
        {
          code: 'item-not-found',
          message: `Theme set item "${itemId}" was not found`,
          path: ['items'],
        },
      ],
    };
  }

  const parsedArtifact = artifactEvidenceSchema.safeParse(records.artifact);
  if (!parsedArtifact.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsedArtifact.error.issues) };
  }
  if (parsedArtifact.data.kind !== 'selected-brief') {
    return {
      ok: false,
      reasons: [
        {
          code: 'artifact-not-selected-brief',
          message: `Edited-brief artifact must have kind "selected-brief" (got "${parsedArtifact.data.kind}")`,
          path: ['artifact', 'kind'],
        },
      ],
    };
  }
  const parsedEvidence = artifactEvidenceSchema.safeParse(records.evidence);
  if (!parsedEvidence.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsedEvidence.error.issues) };
  }

  const nextState: ThemeEquipmentSetState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    items: state.items.map((candidate) =>
      candidate.id === itemId
        ? {
            ...candidate,
            revision: candidate.revision + 1,
            phases: {
              ...candidate.phases,
              briefs: {
                artifacts: [parsedArtifact.data],
                evidence: [parsedEvidence.data],
                review: { verdict: 'up' as const },
              },
            },
          }
        : candidate,
    ),
    // Reviewed content changed → invalidate the set-level briefs review.
    phases: {
      ...state.phases,
      briefs: emptyThemeEquipmentSetPhaseReview(),
    },
  };

  return { ok: true, state: parseThemeEquipmentSetState(nextState) };
}

/** Applies the set-level (collection-wide) human up/down/null review for the current phase. */
export function applyThemeSetPhaseHumanReview(
  input: unknown,
  review: unknown,
): ThemeSetMutationResult {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsed.error.issues) };
  }
  const state = parsed.data;
  if (!isReviewPhase(state.phase)) {
    return {
      ok: false,
      reasons: [
        {
          code: 'phase-not-reviewable',
          message: `Cannot apply set-level human review during phase "${state.phase}"`,
          path: ['phase'],
        },
      ],
    };
  }
  const parsedReview = reviewSchema.safeParse(review);
  if (!parsedReview.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsedReview.error.issues) };
  }

  const nextState: ThemeEquipmentSetState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    phases: {
      ...state.phases,
      [state.phase]: {
        ...state.phases[state.phase],
        humanReview: parsedReview.data,
      },
    },
  };

  return { ok: true, state: parseThemeEquipmentSetState(nextState) };
}

/** Records the collection judge's score/rationale/provenance for the current phase. */
export function applyThemeSetPhaseCollectionJudge(
  input: unknown,
  judge: unknown,
): ThemeSetMutationResult {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsed.error.issues) };
  }
  const state = parsed.data;
  if (!isReviewPhase(state.phase)) {
    return {
      ok: false,
      reasons: [
        {
          code: 'phase-not-reviewable',
          message: `Cannot record collection judge result during phase "${state.phase}"`,
          path: ['phase'],
        },
      ],
    };
  }
  const parsedJudge = collectionJudgeResultSchema.safeParse(judge);
  if (!parsedJudge.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsedJudge.error.issues) };
  }

  const nextState: ThemeEquipmentSetState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    phases: {
      ...state.phases,
      [state.phase]: {
        ...state.phases[state.phase],
        collectionJudge: parsedJudge.data,
      },
    },
  };

  return { ok: true, state: parseThemeEquipmentSetState(nextState) };
}

/**
 * Marks a theme equipment set's publication record as published. Requires
 * `phase === 'complete'` and a currently-`held` publication — this is the
 * only pure mutation allowed to flip `publication.status`, and it is meant
 * to be called exactly once, after a caller (see
 * `publishThemeEquipmentSet` in `theme-equipment-pipeline.ts`) has already
 * completed the one real side effect (the combined queue commit)
 * successfully. `details.publishedAt` must be supplied by the caller (an
 * injected `now()`, never `Date.now()` from inside this pure module).
 */
export function markThemeEquipmentSetPublished(
  input: unknown,
  details: { readonly publishedAt: string; readonly queueCommit: string | null },
): ThemeSetMutationResult {
  const parsed = themeEquipmentSetStateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsed.error.issues) };
  }
  const state = parsed.data;
  if (state.phase !== 'complete') {
    return {
      ok: false,
      reasons: [
        {
          code: 'not-complete',
          message: `Cannot publish theme set "${state.id}": phase is "${state.phase}", not "complete"`,
          path: ['phase'],
        },
      ],
    };
  }
  if (state.publication.status !== 'held') {
    return {
      ok: false,
      reasons: [
        {
          code: 'already-published',
          message: `Theme set "${state.id}" publication is already "${state.publication.status}"`,
          path: ['publication', 'status'],
        },
      ],
    };
  }

  const parsedDetails = z
    .object({
      publishedAt: z.string().trim().min(1),
      queueCommit: z.string().trim().min(1).nullable(),
    })
    .safeParse(details);
  if (!parsedDetails.success) {
    return { ok: false, reasons: zodIssuesToGateReasons(parsedDetails.error.issues) };
  }

  const nextState: ThemeEquipmentSetState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    publication: {
      status: 'published',
      publishedAt: parsedDetails.data.publishedAt,
      queueCommit: parsedDetails.data.queueCommit,
    },
  };

  return { ok: true, state: parseThemeEquipmentSetState(nextState) };
}

// ---------------------------------------------------------------------------
// Authored plan → initial roster-phase state
// ---------------------------------------------------------------------------
//
// Authoring a full `ThemeEquipmentSetState` by hand (every item's four empty
// phase records, the set-level phase record, a held publication record) is
// mechanical and error-prone. Theme authors instead write a small, flat
// "plan" (id/displayName/themeDesignLanguage + weapon/equipment concept
// lists) and `buildThemeEquipmentSetStateFromPlan` expands it into a fully
// valid roster-phase state using the same empty-state factories every other
// mutation in this module uses, so a hand-authored plan can never drift from
// what a runtime-initialized state actually looks like.

const themeEquipmentSetPlanWeaponSchema = z
  .object({
    id: kebabIdSchema,
    displayName: z.string().trim().min(1),
    weaponType: z.string().trim().min(1),
  })
  .strict();

const themeEquipmentSetPlanEquipmentSchema = z
  .object({
    id: kebabIdSchema,
    displayName: z.string().trim().min(1),
    slots: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export const themeEquipmentSetPlanSchema = z
  .object({
    id: kebabIdSchema,
    displayName: z.string().trim().min(1),
    /** Fixed, human-authored design language — never LLM-derived. */
    themeDesignLanguage: z.string().trim().min(1),
    weapons: z.array(themeEquipmentSetPlanWeaponSchema),
    equipment: z.array(themeEquipmentSetPlanEquipmentSchema),
  })
  .strict();

export type ThemeEquipmentSetPlan = z.infer<typeof themeEquipmentSetPlanSchema>;

/**
 * Expand an authored plan into a fully valid `roster`-phase
 * `ThemeEquipmentSetState`: every item starts open/unfrozen with empty phase
 * records, the set-level phase record and publication are both freshly
 * empty/held, and `stateRevision` starts at 0. Throws
 * `ThemeEquipmentSetValidationError` (via `parseThemeEquipmentSetState`) if
 * the expanded state fails schema or coverage validation — e.g. too few
 * distinct weapon types, too few distinct non-hand slots, or a duplicate
 * item id shared between the weapon and equipment lists.
 */
export function buildThemeEquipmentSetStateFromPlan(
  plan: unknown,
  options: { readonly updatedAt: string },
): ThemeEquipmentSetState {
  const parsedPlan = themeEquipmentSetPlanSchema.parse(plan);

  const items: ThemeEquipmentSetItem[] = [
    ...parsedPlan.weapons.map(
      (weapon): ThemeEquipmentSetItem => ({
        id: weapon.id,
        displayName: weapon.displayName,
        kind: 'weapon',
        weaponType: weapon.weaponType,
        revision: 0,
        revisionStatus: 'open',
        frozenPhases: [],
        phases: emptyThemeEquipmentItemPhases(),
      }),
    ),
    ...parsedPlan.equipment.map(
      (equipment): ThemeEquipmentSetItem => ({
        id: equipment.id,
        displayName: equipment.displayName,
        kind: 'equipment',
        slots: [...equipment.slots],
        revision: 0,
        revisionStatus: 'open',
        frozenPhases: [],
        phases: emptyThemeEquipmentItemPhases(),
      }),
    ),
  ];

  return parseThemeEquipmentSetState({
    schemaVersion: THEME_EQUIPMENT_SET_SCHEMA_VERSION,
    id: parsedPlan.id,
    displayName: parsedPlan.displayName,
    themeDesignLanguage: parsedPlan.themeDesignLanguage,
    phase: 'roster',
    items,
    phases: emptyThemeEquipmentSetPhases(),
    publication: emptyThemeEquipmentSetPublication(),
    stateRevision: 0,
    updatedAt: options.updatedAt,
  });
}

/**
 * Read + validate an authored plan JSON file from
 * `data/theme-equipment-sets/<planId>.json` (or an explicit `planPath`). Kept separate from
 * `buildThemeEquipmentSetStateFromPlan` (which stays disk-free) so tests can
 * feed an in-memory plan object without touching the filesystem.
 */
export function loadThemeEquipmentSetPlan(
  planId: string,
  options: { readonly projectRoot?: string; readonly planPath?: string } = {},
): ThemeEquipmentSetPlan {
  const projectRoot = options.projectRoot ?? process.cwd();
  const planPath =
    options.planPath ?? path.join(projectRoot, 'data', 'theme-equipment-sets', `${planId}.json`);
  const raw = JSON.parse(readFileSync(planPath, 'utf8')) as unknown;
  return themeEquipmentSetPlanSchema.parse(raw);
}

export async function loadThemeEquipmentSetState(
  store: RunStore,
  setId: string,
): Promise<ThemeEquipmentSetState | null> {
  const key = themeEquipmentSetStateKey(setId);
  try {
    const raw = JSON.parse((await store.get(key)).toString('utf8')) as unknown;
    return parseThemeEquipmentSetState(raw);
  } catch (error) {
    if (error instanceof StoreNotFoundError) {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new ThemeEquipmentSetValidationError([
        {
          code: 'invalid-json',
          message: `Theme equipment set state ${key} is not valid JSON: ${error.message}`,
        },
      ]);
    }
    throw error;
  }
}

export async function saveThemeEquipmentSetState(
  store: RunStore,
  state: ThemeEquipmentSetState,
  options: {
    readonly expectedRevision: number | null;
    readonly now: () => Date;
  },
): Promise<ThemeEquipmentSetState> {
  const key = themeEquipmentSetStateKey(state.id);
  const nextState = parseThemeEquipmentSetState({
    ...state,
    updatedAt: options.now().toISOString(),
  });
  const data = Buffer.from(`${JSON.stringify(nextState, null, 2)}\n`);

  // A shared backend MUST have server-enforced compare-and-swap. Feature
  // detection alone is not sufficient evidence of that: `LocalRunStore`
  // implements both methods but checks the precondition with a separate `stat`
  // before writing, and a wrapper can expose the methods while the underlying
  // guarantee is weaker. Without atomic CAS, two writers can both observe
  // `expectedRevision` as current and both commit, silently discarding one
  // side's work. Refuse before reading or writing anything.
  const supportsConditionalWrite =
    typeof store.getWithETag === 'function' && typeof store.putConditional === 'function';
  if (
    store.backend === 'azure-blob' &&
    !(supportsConditionalWrite && store.conditionalWrites === 'atomic')
  ) {
    throw new Error(
      `Refusing to save ${key}: the ${store.backend} store does not provide atomic ` +
        `conditional writes (conditionalWrites=${store.conditionalWrites ?? 'unsupported'}, ` +
        `methods=${supportsConditionalWrite ? 'present' : 'missing'}), so revision checks ` +
        'could not be enforced and a concurrent writer could be silently overwritten. ' +
        'This usually means a store wrapper is not forwarding getWithETag/putConditional.',
    );
  }

  if (store.getWithETag && store.putConditional) {
    // Atomic compare-and-swap path: read ETag, validate revision, write with If-Match.
    let etag: string | undefined;
    try {
      const result = await store.getWithETag(key);
      const raw = JSON.parse(result.data.toString('utf8')) as unknown;
      const stored = themeEquipmentSetStateSchema.safeParse(raw);
      const actualRevision = stored.success ? stored.data.stateRevision : null;
      if (actualRevision !== options.expectedRevision) {
        throw new ThemeEquipmentSetRevisionConflictError(
          key,
          options.expectedRevision,
          actualRevision,
        );
      }
      etag = result.etag;
    } catch (error) {
      if (error instanceof StoreNotFoundError) {
        if (options.expectedRevision !== null) {
          throw new ThemeEquipmentSetRevisionConflictError(key, options.expectedRevision, null);
        }
        // etag stays undefined — use If-None-Match: * for create-only write
      } else {
        throw error;
      }
    }
    const conditions = etag !== undefined ? { ifMatch: etag } : { ifNoneMatch: '*' };
    try {
      await store.putConditional(key, data, conditions);
    } catch (error) {
      if (error instanceof StoreConditionalWriteError) {
        throw new ThemeEquipmentSetRevisionConflictError(key, options.expectedRevision, null);
      }
      throw error;
    }
  } else {
    // Fallback: check-then-write (test doubles and local stores without ETag
    // support). This is NOT a cross-process lock — the read and the write are
    // separate operations, so a concurrent writer can commit in between and be
    // silently overwritten. The atomicity gate above already refused every
    // shared (`azure-blob`) backend, so only single-machine stores reach here.
    const stored = await loadThemeEquipmentSetState(store, state.id);
    const actualRevision = stored?.stateRevision ?? null;
    if (
      (actualRevision === null && options.expectedRevision !== null) ||
      (actualRevision !== null && actualRevision !== options.expectedRevision)
    ) {
      throw new ThemeEquipmentSetRevisionConflictError(
        key,
        options.expectedRevision,
        actualRevision,
      );
    }
    await store.put(key, data);
  }
  return nextState;
}

function nextThemeEquipmentSetPhase(phase: ThemeEquipmentSetPhase): ThemeEquipmentSetPhase | null {
  const index = THEME_EQUIPMENT_SET_PHASES.indexOf(phase);
  if (index < 0 || index >= THEME_EQUIPMENT_SET_PHASES.length - 1) {
    return null;
  }
  return THEME_EQUIPMENT_SET_PHASES[index + 1] ?? null;
}

/**
 * True when `phase` is one of the four review phases (`roster`, `briefs`,
 * `sprite-sheets`, `variant-approval`) as opposed to the terminal `complete`
 * phase. Exported so pipeline orchestration (see
 * `theme-equipment-pipeline.ts`) can narrow `state.phase` before calling
 * phase-scoped helpers like `isThemeSetItemResolvedForPhase`.
 */
export function isReviewPhase(
  phase: ThemeEquipmentSetPhase,
): phase is ThemeEquipmentSetReviewPhase {
  return REVIEW_PHASE_SET.has(phase);
}

function addFrozenPhase(
  frozenPhases: readonly ThemeEquipmentSetReviewPhase[],
  phase: ThemeEquipmentSetReviewPhase,
): ThemeEquipmentSetReviewPhase[] {
  return frozenPhases.includes(phase) ? [...frozenPhases] : [...frozenPhases, phase];
}

function zodIssuesToGateReasons(issues: readonly z.core.$ZodIssue[]): ThemeSetGateReason[] {
  return issues.map((issue) => ({
    code: 'invalid-state',
    message: issue.message,
    path: issue.path.map((part) => (typeof part === 'symbol' ? part.toString() : part)),
  }));
}
