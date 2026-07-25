import { z } from 'zod';
import {
  FLOOR2_BOSS_ABILITY_CATALOG,
  getFloor2BossAbilityById,
  type BossAbilityCatalog,
  type BossAbilityDef,
} from '../../src/shared/boss-abilities.js';
import statusJson from './data/boss-abilities.floor2.status.json';

const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const workStateSchema = z.enum(['blocked', 'in-progress', 'not-started', 'verified']);
const assetWorkStateSchema = z.enum([
  'approved',
  'in-progress',
  'not-authored',
  'not-requested',
  'planned',
  'requested',
  'verified',
]);
const labStateSchema = z.enum([
  'blocked',
  'in-progress',
  'not-required',
  'not-started',
  'verified',
]);

const externalRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('issue'),
      number: z.number().int().positive(),
      state: z.enum(['closed', 'open']),
      title: z.string().min(1),
      url: z.string().url(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pull-request'),
      number: z.number().int().positive(),
      state: z.enum(['closed', 'merged', 'open']),
      title: z.string().min(1),
      url: z.string().url(),
    })
    .strict(),
]);

const gateSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['delivery-milestone', 'external-dependency']),
    state: z.enum(['closed-no-merge', 'in-progress', 'not-started', 'open', 'verified']),
    reason: z.string().min(40),
    ref: externalRefSchema.nullable(),
  })
  .strict()
  .superRefine((gate, ctx) => {
    if (gate.kind === 'external-dependency' && gate.ref?.kind !== 'pull-request') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: 'external dependency gates must reference a pull request',
      });
    }
    if (gate.kind === 'delivery-milestone' && gate.ref !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: 'delivery milestones must not carry an external ref',
      });
    }
  });

const bossArtStatusSchema = z
  .object({
    runtimeBriefId: idSchema,
    approvedAssetId: idSchema,
    evidenceKind: z.enum(['committed-brief', 'manifest-only', 'runtime-alias']),
    sourceBriefPath: z.string().min(1).nullable(),
    assetRequest: externalRefSchema.nullable(),
    runtimeWiringState: z.literal('verified'),
  })
  .strict()
  .superRefine((art, ctx) => {
    const hasCommittedBrief = art.sourceBriefPath !== null;
    if ((art.evidenceKind === 'committed-brief') !== hasCommittedBrief) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceBriefPath'],
        message:
          'committed-brief evidence requires a source brief path and no other evidence kind may claim one',
      });
    }
    if (art.assetRequest !== null && art.assetRequest.kind !== 'issue') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetRequest'],
        message: 'asset requests must reference GitHub issues',
      });
    }
  });

export const bossAbilityStatusEntrySchema = z
  .object({
    abilityId: idSchema,
    designState: z.literal('approved'),
    foundationState: workStateSchema.exclude(['blocked']),
    runtimeState: workStateSchema.exclude(['blocked']),
    bossArt: bossArtStatusSchema,
    telegraphVfxState: assetWorkStateSchema,
    telegraphVfxAssetRequest: externalRefSchema.nullable(),
    codexIconState: assetWorkStateSchema,
    codexIconAssetRequest: externalRefSchema.nullable(),
    castAnimationState: assetWorkStateSchema,
    castAnimationAssetRequest: externalRefSchema.nullable(),
    arenaLabState: labStateSchema,
    arenaLabPresetId: z.string().min(1).nullable(),
    arenaLabEvidence: z.string().min(1).nullable(),
    animationLabState: labStateSchema,
    animationLabEvidence: z.string().min(1).nullable(),
    implementationIssue: externalRefSchema.nullable(),
    implementationPullRequest: externalRefSchema.nullable(),
    blockers: z.array(idSchema),
  })
  .strict()
  .superRefine((status, ctx) => {
    if (status.implementationIssue !== null && status.implementationIssue.kind !== 'issue') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementationIssue'],
        message: 'implementationIssue must reference an issue',
      });
    }
    if (
      status.implementationPullRequest !== null &&
      status.implementationPullRequest.kind !== 'pull-request'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementationPullRequest'],
        message: 'implementationPullRequest must reference a pull request',
      });
    }
    if (status.castAnimationState === 'not-authored') {
      if (status.animationLabState !== 'not-required' || status.animationLabEvidence !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['animationLabState'],
          message: 'unauthored cast animation must keep animation-lab proof not-required and empty',
        });
      }
    } else if (status.animationLabState === 'not-required') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['animationLabState'],
        message: 'authored cast animation makes animation-lab proof required',
      });
    }
    if (status.arenaLabState === 'verified') {
      if (status.arenaLabEvidence === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['arenaLabEvidence'],
          message: 'verified arena-lab state requires evidence',
        });
      }
      if (status.arenaLabPresetId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['arenaLabPresetId'],
          message: 'verified arena-lab state requires a canonical combat-arena preset id',
        });
      }
    }
    if (status.animationLabState === 'verified' && status.animationLabEvidence === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['animationLabEvidence'],
        message: 'verified animation-lab state requires evidence',
      });
    }
    if (
      status.animationLabState === 'verified' &&
      status.castAnimationState !== 'approved' &&
      status.castAnimationState !== 'verified'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['animationLabState'],
        message:
          'verified animation-lab proof requires a produced cast animation (approved or verified)',
      });
    }
  });

export type BossAbilityStatusEntry = z.infer<typeof bossAbilityStatusEntrySchema>;

export const bossAbilityStatusPackSchema = z
  .object({
    schemaVersion: z.literal('boss-ability-status/v1'),
    catalogSchemaVersion: z.literal('boss-abilities/v1'),
    lastAuditedAt: z.iso.date(),
    gates: z.array(gateSchema),
    entries: z.array(bossAbilityStatusEntrySchema),
  })
  .strict()
  .superRefine((pack, ctx) => {
    const gateIds = new Set<string>();
    for (const [index, gate] of pack.gates.entries()) {
      if (gateIds.has(gate.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gates', index, 'id'],
          message: `duplicate gate "${gate.id}"`,
        });
      }
      gateIds.add(gate.id);
    }

    const abilityIds = new Set<string>();
    for (const [index, entry] of pack.entries.entries()) {
      if (abilityIds.has(entry.abilityId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', index, 'abilityId'],
          message: `duplicate ability status "${entry.abilityId}"`,
        });
      }
      abilityIds.add(entry.abilityId);
      for (const [blockerIndex, blockerId] of entry.blockers.entries()) {
        if (!gateIds.has(blockerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['entries', index, 'blockers', blockerIndex],
            message: `unknown blocker gate "${blockerId}"`,
          });
        }
      }
    }
  });

export type BossAbilityStatusPack = z.infer<typeof bossAbilityStatusPackSchema>;
export type BossAbilityDeliveryStage =
  | 'blocked'
  | 'designed'
  | 'in-progress'
  | 'ready'
  | 'verified';

function validateStatusCoverage(pack: BossAbilityStatusPack, catalog: BossAbilityCatalog): void {
  const remainingAbilityIds = new Set(catalog.entries.map((ability) => ability.id));
  const errors: string[] = [];
  for (const entry of pack.entries) {
    if (!remainingAbilityIds.delete(entry.abilityId)) {
      errors.push(`status references unknown or duplicate ability "${entry.abilityId}"`);
    }
  }
  for (const missingAbilityId of remainingAbilityIds) {
    errors.push(`ability "${missingAbilityId}" has no status entry`);
  }
  if (pack.entries.length !== catalog.entries.length) {
    errors.push(
      `status has ${pack.entries.length} entries but catalog has ${catalog.entries.length}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Invalid boss ability status coverage:\n- ${errors.join('\n- ')}`);
  }
}

export function loadFloor2BossAbilityStatus(
  json: unknown = statusJson,
  catalog: BossAbilityCatalog = FLOOR2_BOSS_ABILITY_CATALOG,
): BossAbilityStatusPack {
  const pack = bossAbilityStatusPackSchema.parse(json);
  validateStatusCoverage(pack, catalog);
  return pack;
}

export const FLOOR2_BOSS_ABILITY_STATUS = loadFloor2BossAbilityStatus();

export function unresolvedBossAbilityBlockers(
  entry: BossAbilityStatusEntry,
  pack: BossAbilityStatusPack = FLOOR2_BOSS_ABILITY_STATUS,
): readonly string[] {
  const gates = new Map(pack.gates.map((gate) => [gate.id, gate]));
  return entry.blockers.filter((blockerId) => gates.get(blockerId)?.state !== 'verified');
}

export function deriveBossAbilityDeliveryStage(
  entry: BossAbilityStatusEntry,
  pack: BossAbilityStatusPack = FLOOR2_BOSS_ABILITY_STATUS,
): BossAbilityDeliveryStage {
  const animationProofComplete =
    entry.castAnimationState === 'not-authored' || entry.animationLabState === 'verified';
  const unresolvedBlockers = unresolvedBossAbilityBlockers(entry, pack);
  if (
    entry.foundationState === 'verified' &&
    entry.runtimeState === 'verified' &&
    entry.telegraphVfxState === 'verified' &&
    entry.arenaLabState === 'verified' &&
    unresolvedBlockers.length === 0 &&
    animationProofComplete
  ) {
    return 'verified';
  }
  if (
    entry.foundationState === 'in-progress' ||
    entry.runtimeState === 'in-progress' ||
    entry.telegraphVfxState === 'in-progress' ||
    entry.arenaLabState === 'in-progress' ||
    (entry.castAnimationState !== 'not-authored' && entry.animationLabState === 'in-progress')
  ) {
    return 'in-progress';
  }
  if (unresolvedBlockers.length > 0) {
    return 'blocked';
  }
  if (entry.foundationState === 'verified') {
    return 'ready';
  }
  return 'designed';
}

export interface BossAbilityStatusRecord {
  readonly ability: BossAbilityDef;
  readonly status: BossAbilityStatusEntry;
  readonly stage: BossAbilityDeliveryStage;
  readonly unresolvedBlockers: readonly string[];
}

export function buildBossAbilityStatusRecords(
  pack: BossAbilityStatusPack = FLOOR2_BOSS_ABILITY_STATUS,
): readonly BossAbilityStatusRecord[] {
  return pack.entries.map((status) => {
    const ability = getFloor2BossAbilityById(status.abilityId);
    if (ability === undefined) {
      throw new Error(`Status references missing ability "${status.abilityId}"`);
    }
    return {
      ability,
      status,
      stage: deriveBossAbilityDeliveryStage(status, pack),
      unresolvedBlockers: unresolvedBossAbilityBlockers(status, pack),
    };
  });
}

export function formatBossAbilityStatusReport(
  pack: BossAbilityStatusPack = FLOOR2_BOSS_ABILITY_STATUS,
): string {
  const records = buildBossAbilityStatusRecords(pack);
  const stageCounts = new Map<BossAbilityDeliveryStage, number>();
  for (const record of records) {
    stageCounts.set(record.stage, (stageCounts.get(record.stage) ?? 0) + 1);
  }
  const committedBriefs = records.filter(
    ({ status }) => status.bossArt.evidenceKind === 'committed-brief',
  ).length;
  const verifiedCodexIcons = records.filter(
    ({ status }) => status.codexIconState === 'verified',
  ).length;
  const authoredAnimations = records.filter(
    ({ status }) =>
      status.castAnimationState === 'approved' || status.castAnimationState === 'verified',
  ).length;
  const lines = [
    `Floor 2 boss abilities: ${records.length}`,
    `Catalog: ${pack.catalogSchemaVersion} | Status: ${pack.schemaVersion} | audited ${pack.lastAuditedAt}`,
    `Stages: ${[...stageCounts.entries()].map(([stage, count]) => `${stage}=${count}`).join(', ')}`,
    `Art: body-wired=${records.length}/${records.length}, committed-briefs=${committedBriefs}/${records.length}, codex-icons=${verifiedCodexIcons}/${records.length}, authored-cast-animations=${authoredAnimations}/${records.length}`,
    '',
    'Gates:',
    ...pack.gates.map((gate) => {
      const suffix =
        gate.ref === null ? '' : ` (${gate.ref.kind} #${gate.ref.number}: ${gate.ref.state})`;
      return `  [${gate.state}] ${gate.id}${suffix}`;
    }),
    '',
    'Abilities:',
  ];

  for (const record of records) {
    lines.push(`  [${record.stage}] ${record.ability.bossName} — ${record.ability.attackName}`);
    lines.push(
      `    runtime=${record.status.runtimeState} telegraph-vfx=${record.status.telegraphVfxState} arena=${record.status.arenaLabState} animation=${record.status.castAnimationState} animation-lab=${record.status.animationLabState}`,
    );
    if (record.unresolvedBlockers.length > 0) {
      lines.push(`    blockers=${record.unresolvedBlockers.join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
