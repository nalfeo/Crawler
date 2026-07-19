import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

// ajv is a transitive dependency available at runtime; load it via createRequire so that
// ESM module resolution does not require it to be a direct package.json entry.
const Ajv = createRequire(import.meta.url)('ajv') as typeof import('ajv');

const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const SHA40_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NODE_ID_PATTERN = /^(slice|packet):[A-Z0-9][A-Z0-9+.-]*$/;
const ACTIVE_STATUSES = new Set(['claimed', 'in_progress', 'pr_open']);
const POST_PR_STATUSES = new Set(['pr_open', 'merged', 'validated']);
const POST_MERGE_STATUSES = new Set(['merged', 'validated']);
const TERMINAL_STATUSES = new Set(['cancelled', 'superseded']);
const PLAN_BEGIN = '<!-- EPIC-CONTRACT:BEGIN -->';
const PLAN_END = '<!-- EPIC-CONTRACT:END -->';

export const EXPECTED_NODE_IDS = [
  'slice:A0',
  'slice:A1',
  'slice:B1',
  'slice:B2',
  'slice:B3',
  'slice:C1',
  'slice:C2',
  'slice:D1',
  'packet:D2-A',
  'packet:D2-B',
  'slice:D2',
  'packet:D3-A',
  'packet:D3-B',
  'slice:D3',
  'slice:E1',
  'slice:E2',
  'packet:E3-A',
  'packet:E3-B',
  'packet:E3-C',
  'slice:E3',
  'slice:F1',
  'slice:F2',
  'slice:F3',
  'slice:F4',
  'slice:G1',
  'packet:G2-A',
  'packet:G2-B+',
  'slice:G2',
  'packet:G3',
  'slice:G3',
  'slice:H1',
  'slice:H2',
  'slice:H3',
  'slice:I1',
  'slice:I2',
  'slice:I3',
  'slice:J',
] as const;

const nullableDateTime = z.string().datetime({ offset: true }).nullable();
const nullableSha = z.string().regex(SHA_PATTERN).nullable();
const nonEmptyTrimmedString = z.string().trim().min(1);
const nullableNonEmptyTrimmedString = nonEmptyTrimmedString.nullable();
const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/nalfeo\/Crawler\/issues\/[1-9][0-9]*$/;
const GITHUB_PR_URL = /^https:\/\/github\.com\/nalfeo\/Crawler\/pull\/[1-9][0-9]*$/;

/** Zod superRefine that enforces JSON Schema `uniqueItems` for string arrays. */
function uniqueStringItems(arr: string[], ctx: z.RefinementCtx): void {
  if (new Set(arr).size !== arr.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Items must be unique' });
  }
}
const issueRefSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url(),
  })
  .strict();
const prRefSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url(),
    head_sha: z.string().regex(SHA40_PATTERN),
  })
  .strict();
const stateIssueRefSchema = issueRefSchema
  .extend({ url: z.string().regex(GITHUB_ISSUE_URL) })
  .superRefine((data, ctx) => {
    if (!data.url.endsWith(`/${data.number}`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Issue URL does not match number ${data.number}`,
        path: ['url'],
      });
    }
  });
const statePrRefSchema = prRefSchema
  .extend({ url: z.string().regex(GITHUB_PR_URL) })
  .superRefine((data, ctx) => {
    if (!data.url.endsWith(`/${data.number}`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `PR URL does not match number ${data.number}`,
        path: ['url'],
      });
    }
  });
const evidenceSchema = z
  .object({
    kind: z.string().min(1),
    path_or_check: z.string().min(1),
    sha256: z.string().regex(SHA256_PATTERN),
    commit: z.string().regex(SHA40_PATTERN),
    recorded_at: z.string().datetime({ offset: true }),
  })
  .strict();
const ownershipSchema = z
  .object({
    claimant: nullableNonEmptyTrimmedString,
    session: nullableNonEmptyTrimmedString,
    source: z.enum(['none', 'parent-issue-bootstrap', 'child-issue-comment']),
    scope: nullableNonEmptyTrimmedString,
    claimed_at: nullableDateTime,
    lease_expires_at: nullableDateTime,
    heartbeat_at: nullableDateTime,
    base_commit: nullableSha,
  })
  .strict();
const reconciliationSchema = z
  .object({
    last_audited_at: nullableDateTime,
    observed_issue_state: z.enum(['open', 'closed']).nullable(),
    observed_pr_state: z.enum(['OPEN', 'CLOSED', 'MERGED']).nullable(),
    observed_head_sha: z.string().regex(SHA40_PATTERN).nullable(),
    observed_merge_commit: z.string().regex(SHA40_PATTERN).nullable(),
    drift: z.array(z.string()),
  })
  .strict();

/**
 * Schema for one stack-base entry — one per unvalidated direct prerequisite.
 * Records the dependency PR facts needed to detect staleness and post-merge rebase requirements.
 */
const stackBaseSchema = z
  .object({
    dependency_node_id: z.string().regex(NODE_ID_PATTERN),
    dependency_pr_number: z.number().int().positive(),
    dependency_branch: z.string().min(1),
    /** The dep's head SHA at the time speculative work was initiated (initial branch point). */
    dependency_head_sha: z.string().regex(SHA40_PATTERN),
    last_resynced_at: z.string().datetime({ offset: true }),
    /**
     * The dep's head SHA at the most recent resync. Stale when this differs
     * from the dep node's cached github.pr.head_sha.
     */
    last_resynced_head: z.string().regex(SHA40_PATTERN),
    /**
     * Set to true once the dep PR merges. Blocks normal lifecycle advancement
     * until the stacked branch is rebased onto main and stacked_work is cleared.
     */
    requires_main_rebase: z.boolean(),
  })
  .strict();

/**
 * Speculative stacked-work metadata on a lifecycle-blocked node.
 * The node's main `status` stays `blocked`; this object tracks orthogonal
 * progress on a stacked branch while prerequisites are under review.
 */
const stackedWorkSchema = z
  .object({
    mode: z.enum(['stacked_in_progress', 'stacked_pr_open']),
    issue: stateIssueRefSchema,
    session: z.string().min(1),
    branch: z.string().min(1),
    /** Present only when mode is stacked_pr_open. */
    pr: statePrRefSchema.nullable(),
    /** One entry per unvalidated direct dependency. Must not be empty. */
    stack_bases: z.array(stackBaseSchema).min(1),
    drift_reason: z.string().nullable(),
  })
  .strict();

const nodeSchema = z
  .object({
    node_id: z.string().regex(NODE_ID_PATTERN),
    display_id: z.string().min(1),
    kind: z.enum(['slice', 'cloud_packet']),
    parent_slice: z
      .string()
      .regex(/^slice:/)
      .nullable(),
    title: z.string().min(1),
    summary: z.string().min(1),
    execution_lane: z.enum([
      'control',
      'registry',
      'catalog-balance',
      'progression',
      'economy',
      'accessible-ux',
      'world-integration',
      'ai-settlement',
      'verification',
    ]),
    persona: z.string().min(1),
    dependencies: z.array(z.string().regex(NODE_ID_PATTERN)).superRefine(uniqueStringItems),
    status: z.enum([
      'blocked',
      'ready',
      'claimed',
      'in_progress',
      'pr_open',
      'merged',
      'validated',
      'cancelled',
      'superseded',
    ]),
    release_requirement: z.enum(['required', 'deferred']),
    deferred_reason: z.string().nullable(),
    status_changed_at: z.string().datetime({ offset: true }),
    github: z
      .object({
        issue: stateIssueRefSchema.nullable(),
        pr: statePrRefSchema.nullable(),
      })
      .strict(),
    ownership: ownershipSchema,
    merge: z
      .object({
        commit: z.string().regex(SHA40_PATTERN).nullable(),
        merged_at: nullableDateTime,
      })
      .strict(),
    evidence_requirements: z.array(z.string().min(1)).min(1).superRefine(uniqueStringItems),
    evidence: z.array(evidenceSchema),
    reconciliation: reconciliationSchema,
    superseded_by: z.string().regex(NODE_ID_PATTERN).nullable(),
    /**
     * Speculative stacked-work metadata. Optional — absent when there is no
     * active speculative work on this node. When present, the node status must
     * remain `blocked`; the field is orthogonal to the normal lifecycle.
     */
    stacked_work: stackedWorkSchema.nullable().optional(),
  })
  .strict();

const epicStateSchema = z
  .object({
    $schema: z.literal('./epic-state.schema.json'),
    schema_version: z.literal('crawler-epic-state/v1'),
    epic_id: z.literal('floor-2-equipment'),
    title: z.string().min(1),
    updated_at: z.string().datetime({ offset: true }),
    plan: z
      .object({
        path: z.literal('docs/knowledge/epics/floor-2-equipment/PLAN.md'),
        contract_version: z.literal('floor-2-equipment/v1'),
        contract_sha256: z.string().regex(SHA256_PATTERN),
      })
      .strict(),
    authority: z
      .object({
        state_role: z.literal('index-cache'),
        sole_global_writer: z.literal('Producer'),
        ordered_sources: z.tuple([
          z.literal('merged-git-and-pr-facts'),
          z.literal('deterministic-commit-addressed-evidence'),
          z.literal('trusted-issue-ownership-and-comments'),
          z.literal('epic-state-index-cache'),
        ]),
      })
      .strict(),
    lifecycle: z
      .object({
        normal: z.tuple([
          z.literal('blocked'),
          z.literal('ready'),
          z.literal('claimed'),
          z.literal('in_progress'),
          z.literal('pr_open'),
          z.literal('merged'),
          z.literal('validated'),
        ]),
        terminal: z.tuple([z.literal('cancelled'), z.literal('superseded')]),
      })
      .strict(),
    claim_policy: z
      .object({
        authority: z.literal('trusted-issue-comments'),
        bootstrap_node: z.literal('slice:A0'),
        default_lease_hours: z.literal(24),
        maximum_without_heartbeat_hours: z.literal(48),
        protocol_headings: z.tuple([
          z.literal('CLAIMED'),
          z.literal('STACKED-WORK'),
          z.literal('BLOCKED'),
          z.literal('UNBLOCKED'),
          z.literal('SCOPE-CHANGE-REQUEST'),
          z.literal('HANDOFF'),
        ]),
      })
      .strict(),
    github: z
      .object({
        repository: z.literal('nalfeo/Crawler'),
        parent_issue: stateIssueRefSchema.nullable(),
      })
      .strict(),
    issue_materialization: z
      .object({
        mode: z.literal('deterministic-plan-only'),
        parent_title: z.string().min(1),
        child_title_prefix: z.string().min(1),
        labels: z.array(z.string().min(1)).superRefine(uniqueStringItems),
        late_bound_fields: z
          .array(z.enum(['parent_issue_number', 'child_issue_number']))
          .superRefine(uniqueStringItems),
      })
      .strict(),
    release: z
      .object({
        required_node_status: z.literal('validated'),
        all_required_nodes: z.literal(true),
        flags: z.tuple([
          z
            .object({
              name: z.literal('floor2EquipmentRegistry'),
              default: z.literal(false),
              validating_nodes: z
                .array(z.string().regex(/^slice:/))
                .min(1)
                .superRefine(uniqueStringItems),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentCatalog'),
              default: z.literal(false),
              validating_nodes: z
                .array(z.string().regex(/^slice:/))
                .min(1)
                .superRefine(uniqueStringItems),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentRewards'),
              default: z.literal(false),
              validating_nodes: z
                .array(z.string().regex(/^slice:/))
                .min(1)
                .superRefine(uniqueStringItems),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentEconomy'),
              default: z.literal(false),
              validating_nodes: z
                .array(z.string().regex(/^slice:/))
                .min(1)
                .superRefine(uniqueStringItems),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentUx'),
              default: z.literal(false),
              validating_nodes: z
                .array(z.string().regex(/^slice:/))
                .min(1)
                .superRefine(uniqueStringItems),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentWorld'),
              default: z.literal(false),
              validating_nodes: z
                .array(z.string().regex(/^slice:/))
                .min(1)
                .superRefine(uniqueStringItems),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentAiMaintenance'),
              default: z.literal(false),
              validating_nodes: z
                .array(z.string().regex(/^slice:/))
                .min(1)
                .superRefine(uniqueStringItems),
            })
            .strict(),
        ]),
      })
      .strict(),
    nodes: z.array(nodeSchema),
    reconciliation: z
      .object({
        mode: z.literal('read-only-proposal'),
        last_offline_validation_at: nullableDateTime,
        last_github_audit_at: nullableDateTime,
        last_reconciled_by: z.string().nullable(),
        drift: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

const planContractSchema = z
  .object({
    contract_version: z.literal('floor-2-equipment/v1'),
    hard_gate: z
      .object({
        metric: z.literal('representative-build median aggregate DPS ratio'),
        intervals: z.tuple([z.literal('level-1-to-6'), z.literal('level-6-to-11')]),
        minimum: z.literal(1.7),
        maximum: z.literal(2.3),
        require_each_interval: z.literal(true),
      })
      .strict(),
    rarities: z.tuple([z.literal('common'), z.literal('uncommon'), z.literal('rare')]),
    deferred_rarities: z.tuple([z.literal('unique')]),
    registry: z
      .object({
        versioned: z.literal(true),
        generated_instance: z.literal(true),
        consumers: z.tuple([
          z.literal('inventory'),
          z.literal('equip'),
          z.literal('achievement-rewards'),
          z.literal('chests'),
          z.literal('merchant'),
          z.literal('floor-carryover'),
        ]),
      })
      .strict(),
    progression: z
      .object({
        reward_resolution: z.literal('unlock-time-immutable'),
        floor_1_equipment_free: z.literal(true),
        floor_2_achievements: z.literal(30),
        run_global_achievements: z.literal(6),
      })
      .strict(),
    economy: z
      .object({
        boss_chest_rarity_percent: z
          .object({
            uncommon: z.literal(85),
            rare: z.literal(15),
          })
          .strict(),
        quartermaster_guaranteed: z.literal(1),
        random_non_quartermaster_shops_min: z.literal(1),
        random_non_quartermaster_shops_max: z.literal(2),
        shop_rarities: z.tuple([z.literal('common'), z.literal('uncommon')]),
      })
      .strict(),
    catalog: z
      .object({
        weapon_count: z.literal(50),
        other_count: z.literal(20),
        sprite_ids: z.array(z.string()).length(70),
      })
      .strict(),
    ux: z
      .object({
        shared_chest_contract: z.literal(true),
        keyboard_pointer_touch_parity: z.literal(true),
        focus_managed: z.literal(true),
        non_color_rarity_cues: z.literal(true),
      })
      .strict(),
    ai: z
      .object({
        real_apis_only: z.literal(true),
        existing_route_planner_only: z.literal(true),
        settlement_maintenance_required: z.literal(true),
      })
      .strict(),
    graph: z
      .object({
        dependencies: z.record(
          z.string().regex(NODE_ID_PATTERN),
          z.array(z.string().regex(NODE_ID_PATTERN)),
        ),
        parent_slices: z.record(
          z.string().regex(NODE_ID_PATTERN),
          z.string().regex(NODE_ID_PATTERN).nullable(),
        ),
      })
      .strict(),
  })
  .strict();

export type EpicState = z.infer<typeof epicStateSchema>;
export type EpicNode = EpicState['nodes'][number];

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly node_id?: string;
}

export interface RepoPatchOperation {
  readonly op: 'replace' | 'add' | 'remove';
  readonly path: string;
  readonly value?: unknown;
  readonly reason: string;
}

export interface ReconciliationProposal {
  readonly repo_patch: ReadonlyArray<RepoPatchOperation>;
  readonly operator_actions: ReadonlyArray<string>;
}

export interface ValidationResult {
  readonly state: EpicState | null;
  readonly errors: ReadonlyArray<Diagnostic>;
  readonly warnings: ReadonlyArray<Diagnostic>;
  readonly blockers: ReadonlyArray<Diagnostic>;
  readonly ready_queue: ReadonlyArray<string>;
  readonly release_ready: boolean;
  readonly proposal: ReconciliationProposal;
}

/**
 * Abstraction over git operations used during validation. Inject a custom
 * implementation in tests to avoid requiring full git history.
 */
export interface GitReader {
  /**
   * Provide either `readContent` (preferred) or legacy `showContent`.
   */
  readContent?(
    commit: string,
    filePath: string,
  ): { readonly content: string; readonly source: 'git' | 'working-tree' } | null;
  /**
   * Backward-compatible legacy alias kept for external tooling that still
   * implements the pre-refactor GitReader shape.
   */
  showContent?(commit: string, filePath: string): string | null;
  /**
   * Provide either `commitStatus` (preferred) or legacy `commitExists`.
   */
  /**
   * `not-a-commit` is accepted as a deprecated legacy alias of `not-commit`.
   */
  commitStatus?(commit: string): 'commit' | 'not-commit' | 'not-a-commit' | 'missing';
  /**
   * Backward-compatible legacy alias kept for external tooling that still
   * implements the pre-refactor GitReader shape.
   * Note: this boolean shape cannot distinguish non-commit objects from commits.
   */
  commitExists?(commit: string): boolean;
}

export interface ValidationOptions {
  readonly repoRoot: string;
  readonly now?: Date;
  readonly planMarkdown?: string;
  readonly schemaDocument?: unknown;
  readonly gitReader?: GitReader;
}

interface MutableValidation {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  blockers: Diagnostic[];
  readyQueue: string[];
  proposal: {
    repo_patch: RepoPatchOperation[];
    operator_actions: string[];
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitShowContent(repoRoot: string, commit: string, filePath: string): string | null {
  try {
    return execFileSync('git', ['show', `${commit}:${filePath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function gitCommitStatus(repoRoot: string, commit: string): 'commit' | 'not-commit' | 'missing' {
  try {
    const objectType = execFileSync('git', ['cat-file', '-t', commit], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return objectType.trim() === 'commit' ? 'commit' : 'not-commit';
  } catch {
    return 'missing';
  }
}

function normalizeCommitStatus(
  status: 'commit' | 'not-commit' | 'not-a-commit' | 'missing',
): 'commit' | 'not-commit' | 'missing' {
  // Legacy GitReader implementations reported non-commit objects as
  // "not-a-commit"; the current contract uses "not-commit".
  return status === 'not-a-commit' ? 'not-commit' : status;
}

function resolveCommitStatus(
  gitReader: GitReader,
  commit: string,
): 'commit' | 'not-commit' | 'missing' {
  if (gitReader.commitStatus) return normalizeCommitStatus(gitReader.commitStatus(commit));
  if (gitReader.commitExists) return gitReader.commitExists(commit) ? 'commit' : 'missing';
  throw new Error('Invalid GitReader: commitStatus or commitExists must be implemented');
}

function readContentAtCommit(
  gitReader: GitReader,
  commit: string,
  filePath: string,
): { readonly content: string; readonly source: 'git' | 'working-tree' } | null {
  if (gitReader.readContent) return gitReader.readContent(commit, filePath);
  if (!gitReader.showContent) {
    throw new Error('Invalid GitReader: readContent or showContent must be implemented');
  }
  // Legacy showContent readers were defined as git-backed lookups.
  const content = gitReader.showContent(commit, filePath);
  return content === null ? null : { content, source: 'git' };
}

/**
 * Creates the production GitReader that shells out to real git commands.
 * Used by `loadAndValidateEpic` and the CLI. In unit tests, inject a custom
 * implementation (e.g. a working-tree reader) via `ValidationOptions.gitReader`
 * to avoid depending on full git history being present in the checkout.
 */
export function createDefaultGitReader(
  repoRoot: string,
): GitReader & Required<Pick<GitReader, 'commitStatus'>> {
  return {
    readContent(commit: string, filePath: string) {
      const gitContent = gitShowContent(repoRoot, commit, filePath);
      if (gitContent !== null) return { content: gitContent, source: 'git' as const };
      if (gitCommitStatus(repoRoot, commit) !== 'missing') return null;
      try {
        return {
          content: readFileSync(resolve(repoRoot, filePath), 'utf8'),
          source: 'working-tree' as const,
        };
      } catch {
        return null;
      }
    },
    commitStatus(commit: string) {
      return gitCommitStatus(repoRoot, commit);
    },
    showContent(commit: string, filePath: string) {
      return gitShowContent(repoRoot, commit, filePath);
    },
    commitExists(commit: string) {
      return gitCommitStatus(repoRoot, commit) === 'commit';
    },
  };
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${path}: ${issue.message}`;
}

export function extractPlanContract(markdown: string): {
  readonly contract: z.infer<typeof planContractSchema>;
  readonly sha256: string;
} {
  const begin = markdown.indexOf(PLAN_BEGIN);
  const end = markdown.indexOf(PLAN_END);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error('PLAN.md is missing the ordered EPIC-CONTRACT markers');
  }
  const section = markdown.slice(begin + PLAN_BEGIN.length, end).trim();
  const match = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(section);
  if (!match?.[1]) {
    throw new Error('EPIC-CONTRACT must contain exactly one fenced JSON object');
  }
  const parsed = planContractSchema.parse(JSON.parse(match[1]) as unknown);
  const ids = parsed.catalog.sprite_ids;
  if (new Set(ids).size !== ids.length) {
    throw new Error('EPIC-CONTRACT catalog sprite_ids must be unique');
  }
  const weapons = ids.filter((id) => id.startsWith('weapon.'));
  if (weapons.length !== parsed.catalog.weapon_count) {
    throw new Error(
      `EPIC-CONTRACT expected ${parsed.catalog.weapon_count} weapon IDs, found ${weapons.length}`,
    );
  }
  if (ids.length - weapons.length !== parsed.catalog.other_count) {
    throw new Error(
      `EPIC-CONTRACT expected ${parsed.catalog.other_count} non-weapon IDs, found ${ids.length - weapons.length}`,
    );
  }
  return {
    contract: parsed,
    sha256: sha256(JSON.stringify(parsed)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sameMembers(actual: unknown, expected: ReadonlyArray<string>): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((item) => actual.includes(item))
  );
}

/**
 * Recursively transform a Draft 2020-12 JSON Schema into an ajv-v6–compatible
 * (Draft 7) schema so we can apply it to manifest data without upgrading ajv.
 *
 * Transformations applied:
 * - Strip the top-level `$schema` meta-URI (ajv v6 would try to resolve it).
 * - Rename `$defs` → `definitions` and rewrite `#/$defs/` refs accordingly.
 * - Replace `prefixItems`+`items:false` (2020-12 tuple syntax) with
 *   `items`+`additionalItems:false` (Draft 7 tuple syntax).
 */
function transformSchemaForAjvV6(obj: unknown, depth = 0): unknown {
  if (Array.isArray(obj)) return obj.map((v) => transformSchemaForAjvV6(v, depth + 1));
  if (obj === null || typeof obj !== 'object') return obj;
  const src = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (k === '$schema' && depth === 0) continue; // drop meta-schema URI
    if (k === '$defs') {
      result['definitions'] = transformSchemaForAjvV6(src[k], depth + 1);
    } else if (k === 'prefixItems') {
      // 2020-12 tuple → Draft 7 tuple
      result['items'] = transformSchemaForAjvV6(src[k], depth + 1);
      if (src['items'] === false) result['additionalItems'] = false;
    } else if (k === 'items' && 'prefixItems' in src) {
      // Already handled above alongside prefixItems
    } else {
      result[k] = transformSchemaForAjvV6(src[k], depth + 1);
    }
  }
  return result;
}

function validateCommittedSchema(
  schemaDocument: unknown,
  input: unknown,
  result: MutableValidation,
): void {
  const schema = z
    .object({
      $schema: z.literal('https://json-schema.org/draft/2020-12/schema'),
      $id: z.string().url(),
      type: z.literal('object'),
      additionalProperties: z.literal(false),
      required: z.array(z.string()),
      properties: z.record(z.string(), z.unknown()),
      $defs: z.record(z.string(), z.unknown()),
    })
    .passthrough()
    .safeParse(schemaDocument);
  if (!schema.success) {
    result.errors.push({
      code: 'schema.invalid',
      message: schema.error.issues.map(formatZodIssue).join('; '),
    });
    return;
  }
  const data = schema.data;
  const expectedRootRequired = [
    '$schema',
    'schema_version',
    'epic_id',
    'title',
    'updated_at',
    'plan',
    'authority',
    'lifecycle',
    'claim_policy',
    'github',
    'issue_materialization',
    'release',
    'nodes',
    'reconciliation',
  ];
  if (!sameMembers(data.required, expectedRootRequired)) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema root required fields drifted from the Zod contract',
    });
  }
  const rootSchemaVersion = isRecord(data.properties.schema_version)
    ? data.properties.schema_version
    : null;
  const rootEpicId = isRecord(data.properties.epic_id) ? data.properties.epic_id : null;
  if (
    rootSchemaVersion?.const !== 'crawler-epic-state/v1' ||
    rootEpicId?.const !== 'floor-2-equipment'
  ) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema root const fields drifted from the Zod contract',
    });
  }
  const claimPolicy = isRecord(data.properties.claim_policy) ? data.properties.claim_policy : null;
  const claimPolicyProps =
    claimPolicy && isRecord(claimPolicy.properties) ? claimPolicy.properties : null;
  const protocolHeadings =
    claimPolicyProps && isRecord(claimPolicyProps.protocol_headings)
      ? claimPolicyProps.protocol_headings
      : null;
  const expectedHeadings = [
    'CLAIMED',
    'STACKED-WORK',
    'BLOCKED',
    'UNBLOCKED',
    'SCOPE-CHANGE-REQUEST',
    'HANDOFF',
  ];
  const actualHeadings = Array.isArray(protocolHeadings?.prefixItems)
    ? protocolHeadings.prefixItems.map((item) =>
        isRecord(item) && typeof item.const === 'string' ? item.const : null,
      )
    : null;
  if (
    actualHeadings === null ||
    protocolHeadings?.items !== false ||
    actualHeadings.length !== expectedHeadings.length ||
    expectedHeadings.some((heading, index) => actualHeadings[index] !== heading)
  ) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema claim_policy.protocol_headings drifted from the Zod contract',
    });
  }
  const defs = data.$defs;
  const issueRef = isRecord(defs.issueRef) ? defs.issueRef : null;
  const prRef = isRecord(defs.prRef) ? defs.prRef : null;
  const node = isRecord(defs.node) ? defs.node : null;
  const stackBase = isRecord(defs.stackBase) ? defs.stackBase : null;
  const stackedWork = isRecord(defs.stackedWork) ? defs.stackedWork : null;
  const nodeProps = node && isRecord(node.properties) ? node.properties : null;
  const expectedNodeRequired = [
    'node_id',
    'display_id',
    'kind',
    'parent_slice',
    'title',
    'summary',
    'execution_lane',
    'persona',
    'dependencies',
    'status',
    'release_requirement',
    'deferred_reason',
    'status_changed_at',
    'github',
    'ownership',
    'merge',
    'evidence_requirements',
    'evidence',
    'reconciliation',
    'superseded_by',
  ];
  if (
    !node ||
    node.additionalProperties !== false ||
    !sameMembers(node.required, expectedNodeRequired)
  ) {
    result.errors.push({
      code: 'schema.contract-parity',
      message:
        'Committed JSON Schema $defs.node required/additionalProperties drifted from the Zod contract',
    });
  }
  const stackedWorkAnyOf =
    nodeProps && isRecord(nodeProps.stacked_work) && Array.isArray(nodeProps.stacked_work.anyOf)
      ? nodeProps.stacked_work.anyOf
      : null;
  const hasStackedWorkRef =
    stackedWorkAnyOf?.some((entry) => isRecord(entry) && entry.$ref === '#/$defs/stackedWork') ??
    false;
  const hasStackedWorkNull =
    stackedWorkAnyOf?.some((entry) => isRecord(entry) && entry.type === 'null') ?? false;
  if (!hasStackedWorkRef || !hasStackedWorkNull) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema stacked_work node property drifted from the Zod contract',
    });
  }
  const issueUrl =
    issueRef && isRecord(issueRef.properties) && isRecord(issueRef.properties.url)
      ? issueRef.properties.url
      : null;
  const prUrl =
    prRef && isRecord(prRef.properties) && isRecord(prRef.properties.url)
      ? prRef.properties.url
      : null;
  if (
    issueUrl?.pattern !== '^https://github\\.com/nalfeo/Crawler/issues/[1-9][0-9]*$' ||
    prUrl?.pattern !== '^https://github\\.com/nalfeo/Crawler/pull/[1-9][0-9]*$'
  ) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema issue/PR URL patterns drifted from the Zod contract',
    });
  }
  if (
    !stackBase ||
    stackBase.additionalProperties !== false ||
    !sameMembers(stackBase.required, [
      'dependency_node_id',
      'dependency_pr_number',
      'dependency_branch',
      'dependency_head_sha',
      'last_resynced_at',
      'last_resynced_head',
      'requires_main_rebase',
    ])
  ) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema $defs.stackBase drifted from the Zod contract',
    });
  }
  const stackBaseProps = stackBase && isRecord(stackBase.properties) ? stackBase.properties : null;
  if (
    !stackBaseProps ||
    !isRecord(stackBaseProps.dependency_head_sha) ||
    stackBaseProps.dependency_head_sha.$ref !== '#/$defs/sha40' ||
    !isRecord(stackBaseProps.last_resynced_head) ||
    stackBaseProps.last_resynced_head.$ref !== '#/$defs/sha40'
  ) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema $defs.stackBase SHA references drifted from the Zod contract',
    });
  }
  if (
    !stackedWork ||
    stackedWork.additionalProperties !== false ||
    !sameMembers(stackedWork.required, [
      'mode',
      'issue',
      'session',
      'branch',
      'pr',
      'stack_bases',
      'drift_reason',
    ])
  ) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema $defs.stackedWork drifted from the Zod contract',
    });
  }
  const stackedWorkProps =
    stackedWork && isRecord(stackedWork.properties) ? stackedWork.properties : null;
  const stackedWorkPrAnyOf =
    stackedWorkProps && isRecord(stackedWorkProps.pr) && Array.isArray(stackedWorkProps.pr.anyOf)
      ? stackedWorkProps.pr.anyOf
      : null;
  const hasStackedPrRef =
    stackedWorkPrAnyOf?.some((entry) => isRecord(entry) && entry.$ref === '#/$defs/prRef') ?? false;
  const hasStackedPrNull =
    stackedWorkPrAnyOf?.some((entry) => isRecord(entry) && entry.type === 'null') ?? false;
  if (
    !stackedWorkProps ||
    !isRecord(stackedWorkProps.mode) ||
    !Array.isArray(stackedWorkProps.mode.enum) ||
    !isRecord(stackedWorkProps.issue) ||
    stackedWorkProps.issue.$ref !== '#/$defs/issueRef' ||
    !hasStackedPrRef ||
    !hasStackedPrNull ||
    !isRecord(stackedWorkProps.stack_bases) ||
    !isRecord(stackedWorkProps.stack_bases.items) ||
    stackedWorkProps.stack_bases.items.$ref !== '#/$defs/stackBase'
  ) {
    result.errors.push({
      code: 'schema.contract-parity',
      message: 'Committed JSON Schema stackedWork references drifted from the Zod contract',
    });
  }

  // Apply the committed JSON Schema to the manifest data so that any divergence
  // between the schema document and the Zod runtime validator is caught immediately.
  try {
    const ajvCompatSchema = transformSchemaForAjvV6(schemaDocument);
    const patched = JSON.parse(
      JSON.stringify(ajvCompatSchema).replace(/#\/\$defs\//g, '#/definitions/'),
    ) as object;
    const ajv = new Ajv({ unknownFormats: 'ignore', schemaId: 'auto', allErrors: true });
    const validate = ajv.compile(patched);
    if (!validate(input)) {
      const messages = (validate.errors ?? [])
        .slice(0, 5)
        .map((error) => `${error.dataPath || '.'}: ${error.message}`)
        .join('; ');
      result.errors.push({
        code: 'schema.manifest-invalid',
        message: `Manifest rejected by committed JSON Schema: ${messages}`,
      });
    }
  } catch (err) {
    result.errors.push({
      code: 'schema.manifest-validation-error',
      message: `Failed to apply JSON Schema to manifest: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function isDependencySatisfied(
  dependency: EpicNode,
  nodesById: ReadonlyMap<string, EpicNode>,
): boolean {
  if (dependency.status === 'validated') return true;
  if (dependency.status !== 'superseded' || !dependency.superseded_by) return false;
  return nodesById.get(dependency.superseded_by)?.status === 'validated';
}

function hasIssueAuthority(state: EpicState, node: EpicNode): boolean {
  if (node.github.issue) return true;
  return node.node_id === state.claim_policy.bootstrap_node && state.github.parent_issue !== null;
}

function dependenciesSatisfied(node: EpicNode, nodesById: ReadonlyMap<string, EpicNode>): boolean {
  return node.dependencies.every((id) => {
    const dependency = nodesById.get(id);
    return dependency ? isDependencySatisfied(dependency, nodesById) : false;
  });
}

function computeReady(
  state: EpicState,
  node: EpicNode,
  nodesById: ReadonlyMap<string, EpicNode>,
): boolean {
  // Any active stacked_work (regardless of requires_main_rebase) prevents the
  // node from entering the ready queue. The Producer must explicitly reconcile
  // and clear the speculative metadata before normal lifecycle advancement can
  // occur — even when all dependencies are otherwise validated.
  // stacked_work is nullable().optional() so both null and undefined mean "absent".
  return (
    node.release_requirement === 'required' &&
    !TERMINAL_STATUSES.has(node.status) &&
    !POST_PR_STATUSES.has(node.status) &&
    !ACTIVE_STATUSES.has(node.status) &&
    node.stacked_work == null &&
    dependenciesSatisfied(node, nodesById) &&
    hasIssueAuthority(state, node)
  );
}

function validateDag(
  state: EpicState,
  nodesById: ReadonlyMap<string, EpicNode>,
  contract: z.infer<typeof planContractSchema>,
  result: MutableValidation,
): void {
  const expected = new Set<string>(EXPECTED_NODE_IDS);
  const actual = new Set<string>();
  const canonicalDependencies = new Map(Object.entries(contract.graph.dependencies));
  const canonicalParentSlices = new Map(Object.entries(contract.graph.parent_slices));
  for (const node of state.nodes) {
    if (actual.has(node.node_id)) {
      result.errors.push({
        code: 'dag.duplicate-node',
        node_id: node.node_id,
        message: `Duplicate node_id ${node.node_id}`,
      });
    }
    actual.add(node.node_id);
    if (!expected.has(node.node_id)) {
      result.errors.push({
        code: 'dag.unexpected-node',
        node_id: node.node_id,
        message: `Unexpected node ${node.node_id}`,
      });
    }
    if (new Set(node.dependencies).size !== node.dependencies.length) {
      result.errors.push({
        code: 'dag.duplicate-dependency',
        node_id: node.node_id,
        message: `${node.node_id} repeats a dependency`,
      });
    }
    for (const dependency of node.dependencies) {
      if (!nodesById.has(dependency)) {
        result.errors.push({
          code: 'dag.missing-dependency',
          node_id: node.node_id,
          message: `${node.node_id} depends on missing ${dependency}`,
        });
      }
      if (dependency === node.node_id) {
        result.errors.push({
          code: 'dag.self-dependency',
          node_id: node.node_id,
          message: `${node.node_id} depends on itself`,
        });
      }
    }
    if (node.kind === 'cloud_packet') {
      if (!node.parent_slice || !nodesById.has(node.parent_slice)) {
        result.errors.push({
          code: 'dag.packet-parent',
          node_id: node.node_id,
          message: `${node.node_id} must name an existing parent slice`,
        });
      }
    } else if (node.parent_slice !== null) {
      result.errors.push({
        code: 'dag.slice-parent',
        node_id: node.node_id,
        message: `${node.node_id} is a slice and cannot have parent_slice`,
      });
    }
  }
  for (const missing of expected) {
    if (!actual.has(missing)) {
      result.errors.push({
        code: 'dag.missing-node',
        node_id: missing,
        message: `Required node ${missing} is missing`,
      });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string, trail: string[]): void => {
    if (visiting.has(nodeId)) {
      result.errors.push({
        code: 'dag.cycle',
        node_id: nodeId,
        message: `Dependency cycle: ${[...trail, nodeId].join(' -> ')}`,
      });
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const node = nodesById.get(nodeId);
    for (const dependency of node?.dependencies ?? []) {
      if (nodesById.has(dependency)) visit(dependency, [...trail, nodeId]);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of state.nodes) visit(node.node_id, []);

  // Reject duplicate node_id entries: a Map silently overwrites duplicates, so
  // check explicitly before building nodesById.
  const nodeIdCounts = new Map<string, number>();
  for (const node of state.nodes) {
    nodeIdCounts.set(node.node_id, (nodeIdCounts.get(node.node_id) ?? 0) + 1);
  }
  for (const [dupId, count] of nodeIdCounts) {
    if (count > 1) {
      result.errors.push({
        code: 'dag.duplicate-node-id',
        node_id: dupId,
        message: `${dupId} appears ${count} times in state.nodes; node_id must be unique`,
      });
    }
  }

  // Validate that dependencies and parent_slice exactly match the canonical plan graph.
  for (const node of state.nodes) {
    const contractDeps = canonicalDependencies.get(node.node_id);
    if (contractDeps === undefined) {
      result.errors.push({
        code: 'dag.unknown-node',
        node_id: node.node_id,
        message: `${node.node_id} is not part of the canonical plan graph`,
      });
      continue;
    }
    const actualDeps = [...node.dependencies].sort();
    const expectedDeps = [...contractDeps].sort();
    if (actualDeps.join('\u0000') !== expectedDeps.join('\u0000')) {
      result.errors.push({
        code: 'dag.dependency-contract-drift',
        node_id: node.node_id,
        message:
          `${node.node_id} dependencies [${actualDeps.join(', ')}] do not match ` +
          `canonical plan [${expectedDeps.join(', ')}]`,
      });
    }
    if (!canonicalParentSlices.has(node.node_id)) {
      result.errors.push({
        code: 'dag.parent-slice-contract-missing',
        node_id: node.node_id,
        message: `${node.node_id} is missing a canonical parent-slice contract entry`,
      });
      continue;
    }
    const canonicalParent = canonicalParentSlices.get(node.node_id) ?? null;
    if (node.parent_slice !== canonicalParent) {
      result.errors.push({
        code: 'dag.parent-slice-contract-drift',
        node_id: node.node_id,
        message:
          `${node.node_id} parent_slice ${String(node.parent_slice)} does not match ` +
          `canonical plan ${String(canonicalParent)}`,
      });
    }
  }

  for (const canonicalNodeId of EXPECTED_NODE_IDS) {
    if (!nodesById.has(canonicalNodeId)) {
      result.errors.push({
        code: 'dag.missing-canonical-node',
        node_id: canonicalNodeId,
        message: `Canonical node ${canonicalNodeId} is missing from state.nodes`,
      });
    }
    if (!canonicalDependencies.has(canonicalNodeId)) {
      result.errors.push({
        code: 'dag.dependency-contract-missing',
        node_id: canonicalNodeId,
        message: `${canonicalNodeId} is missing a canonical dependency contract entry`,
      });
    }
    if (!canonicalParentSlices.has(canonicalNodeId)) {
      result.errors.push({
        code: 'dag.parent-slice-contract-missing',
        node_id: canonicalNodeId,
        message: `${canonicalNodeId} is missing a canonical parent-slice contract entry`,
      });
    }
  }
  // Reverse check: reject extra keys in the contract that are not in the canonical node set.
  for (const contractNodeId of canonicalDependencies.keys()) {
    if (!expected.has(contractNodeId)) {
      result.errors.push({
        code: 'dag.unexpected-contract-dependency-key',
        node_id: contractNodeId,
        message: `contract.graph.dependencies has unexpected key ${contractNodeId} not in canonical node set`,
      });
    }
  }
  for (const contractNodeId of canonicalParentSlices.keys()) {
    if (!expected.has(contractNodeId)) {
      result.errors.push({
        code: 'dag.unexpected-contract-parent-slice-key',
        node_id: contractNodeId,
        message: `contract.graph.parent_slices has unexpected key ${contractNodeId} not in canonical node set`,
      });
    }
  }
}

/**
 * Returns true if the candidate looks like a URI-scheme reference (not a
 * file path).  Used to guard isRepoFile from treating `check:run/123` or
 * `javascript:...` as relative paths.
 */
function hasUriScheme(candidate: string): boolean {
  return /^(?![A-Za-z]:[\\/])[a-z][a-z0-9+.-]*:/i.test(candidate);
}

/**
 * Returns true only for the supported `check:` evidence URI scheme.
 *
 * Accepted formats:
 *   check:run/<positive-integer>   – a GitHub Actions workflow run
 *   check:job/<positive-integer>   – a GitHub Actions job
 *
 * Any other scheme (file:, http:, javascript:, etc.) is rejected so an
 * invented URI cannot satisfy a required evidence kind.  The recorded sha256
 * is a pre-computed commitment made at evidence-record time; check: references
 * cannot be re-verified offline (they require the GitHub API), so validation
 * only confirms the URI format and the associated commit object.
 */
function isCheckEvidenceReference(candidate: string): boolean {
  return /^check:(?:run|job)\/[1-9]\d*$/.test(candidate);
}

function isRepoFile(repoRoot: string, candidate: string): boolean {
  if (hasUriScheme(candidate)) return false;
  if (isAbsolute(candidate)) return false;
  const root = realpathSync(repoRoot);
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

const EVIDENCE_CANONICAL_DIRS: Readonly<Record<string, string>> = {
  handoff: 'docs/knowledge/handoffs/',
  'review-ledger': 'docs/knowledge/review-ledgers/',
};

function validateEvidenceFiles(
  repoRoot: string,
  gitReader: GitReader,
  node: EpicNode,
  result: MutableValidation,
): void {
  for (const kind of ['handoff', 'review-ledger']) {
    const evidence = node.evidence.find((item) => item.kind === kind);
    if (!evidence) {
      result.errors.push({
        code: `evidence.missing-${kind}`,
        node_id: node.node_id,
        message: `${node.node_id} at ${node.status} requires ${kind} evidence`,
      });
      continue;
    }
    const canonicalDir = EVIDENCE_CANONICAL_DIRS[kind];
    if (canonicalDir && !evidence.path_or_check.startsWith(canonicalDir)) {
      result.errors.push({
        code: 'evidence.non-canonical-path',
        node_id: node.node_id,
        message: `${node.node_id} ${kind} evidence must be under ${canonicalDir}`,
      });
      continue;
    }
    if (!isRepoFile(repoRoot, evidence.path_or_check)) {
      result.errors.push({
        code: 'evidence.unsafe-path',
        node_id: node.node_id,
        message: `${node.node_id} evidence path is outside the repository`,
      });
      continue;
    }
    const commitStat = resolveCommitStatus(gitReader, evidence.commit);
    if (commitStat !== 'commit') {
      result.errors.push({
        code: 'evidence.git-verification-failed',
        node_id: node.node_id,
        message:
          commitStat === 'not-commit'
            ? `${node.node_id} evidence commit ${evidence.commit} is not a commit object: ${evidence.path_or_check}`
            : `${node.node_id} evidence commit ${evidence.commit} does not exist: ${evidence.path_or_check}`,
      });
      continue;
    }
    const verification = readContentAtCommit(gitReader, evidence.commit, evidence.path_or_check);
    if (verification === null) {
      result.errors.push({
        code: 'evidence.git-verification-failed',
        node_id: node.node_id,
        message: `${node.node_id} evidence file not found at commit ${evidence.commit}: ${evidence.path_or_check}`,
      });
      continue;
    }
    if (verification.source === 'working-tree') {
      result.warnings.push({
        code: 'evidence.commit-unavailable',
        node_id: node.node_id,
        message:
          `${node.node_id} evidence commit ${evidence.commit} is not locally available; ` +
          `verified ${evidence.path_or_check} against working-tree content instead`,
      });
    }
    const actualHash = sha256(verification.content);
    if (actualHash !== evidence.sha256) {
      result.errors.push({
        code: 'evidence.hash-drift',
        node_id: node.node_id,
        message: `${node.node_id} evidence hash drifted at commit ${evidence.commit}: ${evidence.path_or_check}`,
      });
    }
  }
}

function validateEvidenceRequirements(
  repoRoot: string,
  gitReader: GitReader,
  node: EpicNode,
  result: MutableValidation,
): void {
  const handledKinds = new Set(['handoff', 'review-ledger']);
  for (const requirement of node.evidence_requirements) {
    const evidence = node.evidence.find((item) => item.kind === requirement);
    if (!evidence) {
      result.errors.push({
        code: 'evidence.missing-requirement',
        node_id: node.node_id,
        message: `${node.node_id} lacks required evidence kind ${requirement}`,
      });
      continue;
    }
    if (handledKinds.has(requirement)) continue;
    if (isRepoFile(repoRoot, evidence.path_or_check)) {
      const verification = readContentAtCommit(gitReader, evidence.commit, evidence.path_or_check);
      if (verification === null) {
        result.errors.push({
          code: 'evidence.git-verification-failed',
          node_id: node.node_id,
          message: `${node.node_id} evidence could not be verified at commit ${evidence.commit}: ${evidence.path_or_check}`,
        });
        continue;
      }
      if (verification.source === 'working-tree') {
        result.warnings.push({
          code: 'evidence.commit-unavailable',
          node_id: node.node_id,
          message:
            `${node.node_id} evidence commit ${evidence.commit} is not locally available; ` +
            `verified ${evidence.path_or_check} against working-tree content instead`,
        });
      }
      if (sha256(verification.content) !== evidence.sha256) {
        result.errors.push({
          code: 'evidence.hash-drift',
          node_id: node.node_id,
          message: `${node.node_id} evidence hash drifted at commit ${evidence.commit}: ${evidence.path_or_check}`,
        });
      }
      continue;
    }
    if (!isCheckEvidenceReference(evidence.path_or_check)) {
      result.errors.push({
        code: 'evidence.unsafe-path',
        node_id: node.node_id,
        message: `${node.node_id} evidence path is not a repo file or valid check: reference: ${evidence.path_or_check}`,
      });
      continue;
    }
    const nonFileCommitStatus = resolveCommitStatus(gitReader, evidence.commit);
    if (nonFileCommitStatus !== 'commit') {
      result.errors.push({
        code: 'evidence.git-verification-failed',
        node_id: node.node_id,
        message:
          nonFileCommitStatus === 'not-commit'
            ? `${node.node_id} evidence commit ${evidence.commit} is not a commit object: ${evidence.path_or_check}`
            : `${node.node_id} evidence commit ${evidence.commit} does not exist: ${evidence.path_or_check}`,
      });
    }
  }
}

/**
 * Validates stacked_work metadata on a lifecycle-blocked node.
 *
 * Rules enforced:
 * 1. Speculative work only on `blocked` nodes.
 * 2. `stacked_pr_open` requires a PR ref.
 * 3. One stack_base per unvalidated direct dependency (no extra, no missing).
 * 4. Each dep must be `pr_open` (or `merged`/`validated` with requires_main_rebase: true).
 * 5. Stale detection: dep's cached PR head must match last_resynced_head.
 * 6. Post-merge: when dep is merged/validated, requires_main_rebase must be true
 *    and an operator action is emitted.
 * 7. No duplicate dependency node IDs within stack_bases.
 */
function validateStackedWork(
  node: EpicNode,
  nodesById: ReadonlyMap<string, EpicNode>,
  result: MutableValidation,
): void {
  const sw = node.stacked_work;
  if (!sw) return;

  // Rule 1: node status must be blocked.
  if (node.status !== 'blocked') {
    result.errors.push({
      code: 'stacked.not-blocked',
      node_id: node.node_id,
      message:
        `${node.node_id} has stacked_work but status is ${node.status}; ` +
        'speculative work requires status blocked',
    });
  }

  // Rule 2: stacked_pr_open requires a PR ref.
  if (sw.mode === 'stacked_pr_open' && !sw.pr) {
    result.errors.push({
      code: 'stacked.pr-open-missing-pr',
      node_id: node.node_id,
      message: `${node.node_id} stacked_work mode is stacked_pr_open but pr is null`,
    });
  }

  // Determine all direct dependencies and the subset that are unvalidated.
  // Note: validateDag already catches unknown dependency IDs, so by the time
  // validateStackedWork runs all node.dependencies exist in nodesById.
  const directDepSet = new Set(node.dependencies);
  const unvalidatedDepIds = node.dependencies.filter((depId) => {
    const dep = nodesById.get(depId);
    return dep !== undefined && !isDependencySatisfied(dep, nodesById);
  });

  // Build stack-base index for O(1) lookup.
  const stackBasesByDepId = new Map<string, (typeof sw.stack_bases)[number]>();
  for (const base of sw.stack_bases) {
    stackBasesByDepId.set(base.dependency_node_id, base);
  }

  // Rule 3a: every stack_base dep must be a direct dependency (validated deps
  // with requires_main_rebase=true are a valid transitional state — the
  // stack_base survives until the child branch rebases onto main).
  for (const base of sw.stack_bases) {
    if (!directDepSet.has(base.dependency_node_id)) {
      result.errors.push({
        code: 'stacked.base-not-dependency',
        node_id: node.node_id,
        message:
          `${node.node_id} stacked_work stack_bases includes ${base.dependency_node_id} ` +
          'which is not a direct dependency',
      });
    }
  }

  // Rule 3b: every unvalidated direct dependency must have a stack_base.
  for (const depId of unvalidatedDepIds) {
    if (!stackBasesByDepId.has(depId)) {
      result.errors.push({
        code: 'stacked.missing-base',
        node_id: node.node_id,
        message: `${node.node_id} stacked_work is missing stack_base for unvalidated dependency ${depId}`,
      });
    }
  }

  // Rule 7: no duplicate dependency node IDs in stack_bases.
  const seenDeps = new Set<string>();
  for (const base of sw.stack_bases) {
    if (seenDeps.has(base.dependency_node_id)) {
      result.errors.push({
        code: 'stacked.duplicate-base',
        node_id: node.node_id,
        message: `${node.node_id} stacked_work has duplicate stack_base for ${base.dependency_node_id}`,
      });
    }
    seenDeps.add(base.dependency_node_id);
  }

  // Rules 4, 5, 6: per-dep head and state checks.
  for (const base of sw.stack_bases) {
    const dep = nodesById.get(base.dependency_node_id);
    if (!dep) continue; // already caught by base-not-dependency

    // Rule 4: dep must be pr_open or merged/validated (with rebase flag).
    if (dep.status !== 'pr_open' && !POST_MERGE_STATUSES.has(dep.status)) {
      result.errors.push({
        code: 'stacked.dep-not-pr-open',
        node_id: node.node_id,
        message:
          `${node.node_id} stacked_work dep ${base.dependency_node_id} is ${dep.status}; ` +
          'speculative work requires dep status pr_open (or merged/validated with requires_main_rebase)',
      });
    }

    // Rule 4b: pr_open dep must have a PR ref for stale detection.
    if (dep.status === 'pr_open' && !dep.github.pr) {
      result.errors.push({
        code: 'stacked.dep-missing-pr',
        node_id: node.node_id,
        message:
          `${node.node_id} stacked_work dep ${base.dependency_node_id} is pr_open ` +
          'but has no PR ref; cannot verify stack base',
      });
      continue;
    }

    // Rule 4c: dependency_pr_number must match the dep's recorded PR number.
    if (dep.github.pr && dep.github.pr.number !== base.dependency_pr_number) {
      result.errors.push({
        code: 'stacked.base-pr-mismatch',
        node_id: node.node_id,
        message:
          `${node.node_id} stacked_work stack_base dependency_pr_number ${base.dependency_pr_number} ` +
          `does not match dep ${base.dependency_node_id} recorded PR #${dep.github.pr.number}`,
      });
    }

    // Rule 5: stale detection — dep's cached PR head must match last_resynced_head.
    if (dep.github.pr && dep.github.pr.head_sha !== base.last_resynced_head) {
      result.errors.push({
        code: 'stacked.stale-dep-head',
        node_id: node.node_id,
        message:
          `${node.node_id} stacked_work dep ${base.dependency_node_id} head has advanced ` +
          `(cached: ${dep.github.pr.head_sha}, resynced: ${base.last_resynced_head}); ` +
          'resynchronization required before continuing speculative work',
      });
    }

    // Rules 6a/6b: post-merge rebase requirements.
    if (POST_MERGE_STATUSES.has(dep.status)) {
      if (!base.requires_main_rebase) {
        result.errors.push({
          code: 'stacked.merged-dep-rebase-required',
          node_id: node.node_id,
          message:
            `${node.node_id} stacked_work dep ${base.dependency_node_id} is ${dep.status}; ` +
            'stack_base must set requires_main_rebase: true',
        });
      } else {
        // requires_main_rebase correctly set; rebase has not yet happened — block and emit operator action.
        result.errors.push({
          code: 'stacked.requires-main-rebase',
          node_id: node.node_id,
          message:
            `${node.node_id} stacked branch must be rebased onto main ` +
            `(dep ${base.dependency_node_id} is ${dep.status}); ` +
            'Producer must reconcile after rebase completes and clear stacked_work',
        });
        result.proposal.operator_actions.push(
          `${node.node_id}: dep ${base.dependency_node_id} has ${dep.status}. ` +
            'Rebase the stacked branch onto main, verify the speculative work, ' +
            'then clear stacked_work and advance through the normal lifecycle.',
        );
      }
    }
  }
}

function validateNodeLifecycle(
  state: EpicState,
  node: EpicNode,
  nodesById: ReadonlyMap<string, EpicNode>,
  now: Date,
  repoRoot: string,
  gitReader: GitReader,
  result: MutableValidation,
): void {
  if (
    node.release_requirement === 'deferred' &&
    (!node.deferred_reason || node.deferred_reason.trim().length === 0)
  ) {
    result.errors.push({
      code: 'lifecycle.deferred-reason',
      node_id: node.node_id,
      message: `${node.node_id} is deferred without a reason`,
    });
  }
  if (node.release_requirement === 'deferred' && ACTIVE_STATUSES.has(node.status)) {
    result.errors.push({
      code: 'lifecycle.deferred-active',
      node_id: node.node_id,
      message: `${node.node_id} is deferred but actively claimed`,
    });
  }
  if (node.status === 'superseded') {
    if (!node.superseded_by || !nodesById.has(node.superseded_by)) {
      result.errors.push({
        code: 'lifecycle.superseded-replacement',
        node_id: node.node_id,
        message: `${node.node_id} is superseded without a valid replacement`,
      });
    }
  } else if (node.superseded_by !== null) {
    result.errors.push({
      code: 'lifecycle.unexpected-replacement',
      node_id: node.node_id,
      message: `${node.node_id} names superseded_by but is not superseded`,
    });
  }

  validateStackedWork(node, nodesById, result);

  const ready = computeReady(state, node, nodesById);
  if (ready) result.readyQueue.push(node.node_id);
  if (node.status === 'ready' && !ready) {
    result.errors.push({
      code: 'readiness.false-ready',
      node_id: node.node_id,
      message: `${node.node_id} is cached ready but does not satisfy readiness`,
    });
  }
  if (node.status === 'blocked' && ready) {
    result.warnings.push({
      code: 'readiness.cached-blocked',
      node_id: node.node_id,
      message: `${node.node_id} is computed ready but cached blocked`,
    });
    result.proposal.repo_patch.push({
      op: 'replace',
      path: `/nodes/${state.nodes.indexOf(node)}/status`,
      value: 'ready',
      reason: `${node.node_id} satisfies deterministic readiness`,
    });
  }

  if (
    (ACTIVE_STATUSES.has(node.status) || POST_MERGE_STATUSES.has(node.status)) &&
    !dependenciesSatisfied(node, nodesById)
  ) {
    result.errors.push({
      code: 'readiness.active-lost-dependency',
      node_id: node.node_id,
      message: `${node.node_id} is ${node.status} but one or more dependencies are not validated`,
    });
    result.proposal.operator_actions.push(
      `Post BLOCKED for ${node.node_id}, revoke its lease, and invalidate downstream evidence.`,
    );
  }

  const owns = node.ownership;
  if (ACTIVE_STATUSES.has(node.status)) {
    // heartbeat_at is required only after claiming (i.e. in_progress, pr_open), not for the
    // initial claimed state itself where the heartbeat has not yet been posted.
    const claimFields = [
      owns.claimant,
      owns.session,
      owns.scope,
      owns.claimed_at,
      owns.lease_expires_at,
      owns.base_commit,
    ];
    const requiredOwnership =
      node.status === 'claimed' ? claimFields : [...claimFields, owns.heartbeat_at];
    if (
      owns.source === 'none' ||
      requiredOwnership.some((value) => value === null) ||
      !hasIssueAuthority(state, node)
    ) {
      result.errors.push({
        code: 'ownership.incomplete',
        node_id: node.node_id,
        message: `${node.node_id} is ${node.status} without complete trusted claim metadata`,
      });
    }
    if (
      owns.source === 'parent-issue-bootstrap' &&
      node.node_id !== state.claim_policy.bootstrap_node
    ) {
      result.errors.push({
        code: 'ownership.invalid-bootstrap-source',
        node_id: node.node_id,
        message:
          `${node.node_id} uses parent-issue-bootstrap source but is not the configured ` +
          `bootstrap node (${state.claim_policy.bootstrap_node})`,
      });
    }
    if (owns.lease_expires_at && Date.parse(owns.lease_expires_at) <= now.getTime()) {
      result.errors.push({
        code: 'ownership.stale-claim',
        node_id: node.node_id,
        message: `${node.node_id} claim expired at ${owns.lease_expires_at}`,
      });
      result.proposal.operator_actions.push(
        `Verify ${node.node_id}'s claimant, post BLOCKED or a refreshed CLAIMED heartbeat, then update cached ownership.`,
      );
    }
    if (owns.heartbeat_at) {
      const maxHeartbeatMs = (state.claim_policy.maximum_without_heartbeat_hours ?? 48) * 3_600_000;
      if (now.getTime() - Date.parse(owns.heartbeat_at) > maxHeartbeatMs) {
        result.errors.push({
          code: 'ownership.stale-heartbeat',
          node_id: node.node_id,
          message: `${node.node_id} heartbeat at ${owns.heartbeat_at} exceeds ${state.claim_policy.maximum_without_heartbeat_hours ?? 48}h maximum`,
        });
        result.proposal.operator_actions.push(
          `Verify ${node.node_id}'s claimant, post BLOCKED or a refreshed CLAIMED heartbeat, then update cached ownership.`,
        );
      }
    }
  } else if (
    owns.source !== 'none' ||
    [
      owns.claimant,
      owns.session,
      owns.scope,
      owns.claimed_at,
      owns.lease_expires_at,
      owns.heartbeat_at,
      owns.base_commit,
    ].some((value) => value !== null)
  ) {
    result.errors.push({
      code: 'ownership.inactive-claim',
      node_id: node.node_id,
      message: `${node.node_id} has ownership metadata while status is ${node.status}`,
    });
  }

  if (POST_PR_STATUSES.has(node.status)) {
    if (!node.github.issue || !node.github.pr) {
      result.errors.push({
        code: 'github.pr-open-refs',
        node_id: node.node_id,
        message: `${node.node_id} at ${node.status} requires issue and PR refs`,
      });
    }
    validateEvidenceFiles(repoRoot, gitReader, node, result);
  }
  if (POST_MERGE_STATUSES.has(node.status)) {
    if (!node.merge.commit || !node.merge.merged_at) {
      result.errors.push({
        code: 'merge.missing-facts',
        node_id: node.node_id,
        message: `${node.node_id} at ${node.status} requires merge commit and timestamp`,
      });
    } else {
      const mergeCommitStatus = resolveCommitStatus(gitReader, node.merge.commit);
      if (mergeCommitStatus === 'missing') {
        result.errors.push({
          code: 'merge.commit-not-found',
          node_id: node.node_id,
          message: `${node.node_id} merge commit ${node.merge.commit} does not exist in git`,
        });
      } else if (mergeCommitStatus === 'not-commit') {
        result.errors.push({
          code: 'merge.not-a-commit',
          node_id: node.node_id,
          message: `${node.node_id} merge commit ${node.merge.commit} is not a commit object`,
        });
      }
    }
  }
  if (node.status === 'validated') {
    validateEvidenceRequirements(repoRoot, gitReader, node, result);
  }
  const isEffectivelyDone =
    node.status === 'validated' ||
    (node.status === 'superseded' && isDependencySatisfied(node, nodesById));
  if (!isEffectivelyDone && node.release_requirement === 'required') {
    result.blockers.push({
      code: 'release.node-not-validated',
      node_id: node.node_id,
      message: `${node.node_id} is ${node.status}, not validated`,
    });
  }
  if (!hasIssueAuthority(state, node) && node.node_id !== 'slice:A0') {
    result.blockers.push({
      code: 'materialization.missing-child-issue',
      node_id: node.node_id,
      message: `${node.node_id} has no materialized child issue`,
    });
  }

  // Validate speculative stacked-work metadata (orthogonal to the normal lifecycle).
  validateStackedWork(node, nodesById, result);
}

function validateDuplicateOwnership(state: EpicState, result: MutableValidation): void {
  const ownership = new Map<string, string>();
  const issues = new Map<number, string>();
  const stackedSessions = new Map<string, string>();
  const stackedIssues = new Map<number, string>();
  for (const node of state.nodes) {
    if (ACTIVE_STATUSES.has(node.status) && node.ownership.claimant && node.ownership.session) {
      const key = `${node.ownership.claimant}\u0000${node.ownership.session}`;
      const prior = ownership.get(key);
      if (prior) {
        result.errors.push({
          code: 'ownership.duplicate',
          node_id: node.node_id,
          message: `${node.ownership.claimant}/${node.ownership.session} owns both ${prior} and ${node.node_id}`,
        });
      } else {
        ownership.set(key, node.node_id);
      }
    }
    if (node.github.issue) {
      const prior = issues.get(node.github.issue.number);
      if (prior) {
        result.errors.push({
          code: 'github.duplicate-issue',
          node_id: node.node_id,
          message: `Issue #${node.github.issue.number} is assigned to both ${prior} and ${node.node_id}`,
        });
      } else {
        issues.set(node.github.issue.number, node.node_id);
      }
    }
    if (node.stacked_work) {
      const priorSession = stackedSessions.get(node.stacked_work.session);
      if (priorSession) {
        result.errors.push({
          code: 'stacked.duplicate-session',
          node_id: node.node_id,
          message:
            `stacked_work session ${node.stacked_work.session} is assigned to both ` +
            `${priorSession} and ${node.node_id}`,
        });
      } else {
        stackedSessions.set(node.stacked_work.session, node.node_id);
      }
      const priorIssue = stackedIssues.get(node.stacked_work.issue.number);
      if (priorIssue) {
        result.errors.push({
          code: 'stacked.duplicate-issue',
          node_id: node.node_id,
          message:
            `stacked_work issue #${node.stacked_work.issue.number} is assigned to both ` +
            `${priorIssue} and ${node.node_id}`,
        });
      } else {
        stackedIssues.set(node.stacked_work.issue.number, node.node_id);
      }
    }
  }
}

export function validateEpicState(input: unknown, options: ValidationOptions): ValidationResult {
  const result: MutableValidation = {
    errors: [],
    warnings: [],
    blockers: [],
    readyQueue: [],
    proposal: { repo_patch: [], operator_actions: [] },
  };
  const parsed = epicStateSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      result.errors.push({
        code: 'state.schema',
        message: formatZodIssue(issue),
      });
    }
    return {
      state: null,
      errors: result.errors,
      warnings: result.warnings,
      blockers: result.blockers,
      ready_queue: result.readyQueue,
      release_ready: false,
      proposal: result.proposal,
    };
  }
  const state = parsed.data;

  // Enforce minimum node count (aligned with JSON Schema minItems: 37).
  if (state.nodes.length < 37) {
    result.errors.push({
      code: 'state.min-nodes',
      message: `Epic state must have at least 37 nodes; found ${state.nodes.length}`,
    });
  }

  if (options.schemaDocument !== undefined) {
    validateCommittedSchema(options.schemaDocument, input, result);
  }

  const planMarkdown =
    options.planMarkdown ?? readFileSync(resolve(options.repoRoot, state.plan.path), 'utf8');
  let planContract: z.infer<typeof planContractSchema> | null = null;
  try {
    const contract = extractPlanContract(planMarkdown);
    planContract = contract.contract;
    if (contract.sha256 !== state.plan.contract_sha256) {
      result.errors.push({
        code: 'plan.contract-drift',
        message: `PLAN contract hash is ${contract.sha256}, state records ${state.plan.contract_sha256}`,
      });
      result.proposal.repo_patch.push({
        op: 'replace',
        path: '/plan/contract_sha256',
        value: contract.sha256,
        reason: 'Synchronize state only after the plan-change protocol is complete',
      });
    }
  } catch (error) {
    result.errors.push({
      code: 'plan.contract-invalid',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const contractValid = !result.errors.some(
    (e) => e.code === 'plan.contract-drift' || e.code === 'plan.contract-invalid',
  );

  const nodesById = new Map(state.nodes.map((node) => [node.node_id, node]));
  if (planContract) {
    validateDag(state, nodesById, planContract, result);
  }
  const now = options.now ?? new Date();
  const gitReader = options.gitReader ?? createDefaultGitReader(options.repoRoot);
  for (const node of state.nodes) {
    validateNodeLifecycle(state, node, nodesById, now, options.repoRoot, gitReader, result);
  }
  validateDuplicateOwnership(state, result);

  for (const flag of state.release.flags) {
    for (const nodeId of flag.validating_nodes) {
      if (!nodesById.has(nodeId)) {
        result.errors.push({
          code: 'release.flag-node',
          message: `${flag.name} references missing validating node ${nodeId}`,
        });
      }
    }
  }
  // When the contract hash is invalid, suppress ready/proposal transitions: a changed
  // PLAN must go through the full plan-change protocol before nodes can advance.
  if (!contractValid) {
    result.readyQueue.length = 0;
  }
  result.readyQueue.sort();
  const allRequiredValidated =
    result.errors.length === 0 &&
    state.nodes
      .filter((node) => node.release_requirement === 'required')
      .every((node) => isDependencySatisfied(node, nodesById));
  const allFlagNodesValidated = state.release.flags.every((flag) =>
    flag.validating_nodes.every((nodeId) => {
      const n = nodesById.get(nodeId);
      return n !== undefined && isDependencySatisfied(n, nodesById);
    }),
  );
  const releaseReady = allRequiredValidated && allFlagNodesValidated;
  const suppressedQueue =
    result.errors.length > 0 && result.readyQueue.length > 0 ? result.readyQueue : null;
  if (suppressedQueue) {
    result.warnings.push({
      code: 'ready-queue.suppressed',
      message:
        `Ready queue suppressed due to ${result.errors.length} validation error(s); ` +
        `${suppressedQueue.length} node(s) would otherwise be ready: ${suppressedQueue.join(', ')}`,
    });
  }
  return {
    state,
    errors: result.errors,
    warnings: result.warnings,
    blockers: result.blockers,
    ready_queue: result.errors.length === 0 ? result.readyQueue : [],
    release_ready: releaseReady,
    proposal: result.proposal,
  };
}

export function loadAndValidateEpic(
  epicId: string,
  repoRoot: string,
  now?: Date,
): ValidationResult {
  if (epicId !== 'floor-2-equipment') {
    return {
      state: null,
      errors: [
        {
          code: 'epic.unknown',
          message: `Unknown epic ${epicId}; expected floor-2-equipment`,
        },
      ],
      warnings: [],
      blockers: [],
      ready_queue: [],
      release_ready: false,
      proposal: { repo_patch: [], operator_actions: [] },
    };
  }
  const directory = resolve(repoRoot, 'docs', 'knowledge', 'epics', epicId);
  const state = JSON.parse(readFileSync(resolve(directory, 'epic-state.json'), 'utf8')) as unknown;
  const schema = JSON.parse(
    readFileSync(resolve(directory, 'epic-state.schema.json'), 'utf8'),
  ) as unknown;
  return validateEpicState(state, {
    repoRoot,
    now,
    schemaDocument: schema,
  });
}

export interface MaterializationPacket {
  readonly node_id: string;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
  readonly body: string;
}

function topoSort(nodes: ReadonlyArray<EpicNode>): EpicNode[] {
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const visited = new Set<string>();
  const ordered: EpicNode[] = [];
  const visit = (node: EpicNode): void => {
    if (visited.has(node.node_id)) return;
    visited.add(node.node_id);
    for (const dependency of node.dependencies) {
      const dependencyNode = byId.get(dependency);
      if (dependencyNode) visit(dependencyNode);
    }
    ordered.push(node);
  };
  for (const node of [...nodes].sort((a, b) => a.node_id.localeCompare(b.node_id))) {
    visit(node);
  }
  return ordered;
}

export function buildMaterializationPlan(state: EpicState): ReadonlyArray<MaterializationPacket> {
  const parent = state.github.parent_issue?.number ?? '<parent-issue-number>';
  return topoSort(state.nodes)
    .filter((node) => node.node_id !== 'slice:A0' && node.github.issue === null)
    .map((node) => ({
      node_id: node.node_id,
      title: `${state.issue_materialization.child_title_prefix} ${node.display_id}: ${node.title}`,
      labels: state.issue_materialization.labels,
      body: [
        `Parent: #${parent}`,
        `Node: \`${node.node_id}\``,
        `Lane: \`${node.execution_lane}\``,
        `Persona: ${node.persona}`,
        `Dependencies: ${
          node.dependencies.length > 0
            ? node.dependencies.map((dependency) => `\`${dependency}\``).join(', ')
            : 'none'
        }`,
        '',
        '## Objective',
        node.summary,
        '',
        '## Acceptance evidence',
        ...node.evidence_requirements.map((requirement) => `- \`${requirement}\``),
        '',
        '## Coordination protocol',
        'Use structured CLAIMED, BLOCKED, UNBLOCKED, SCOPE-CHANGE-REQUEST, STACKED-WORK, and HANDOFF comments.',
        'Do not edit the global epic state; the Producer is the sole global-state writer.',
      ].join('\n'),
    }));
}

interface GithubIssue {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly html_url: string;
}

interface GithubPull {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly merge_commit_sha: string | null;
  readonly merged_at: string | null;
  readonly html_url: string;
  readonly head: {
    readonly sha: string;
  };
}

const githubPullSchema = z
  .object({
    number: z.number().int().positive(),
    state: z.enum(['open', 'closed']),
    merged: z.boolean(),
    merge_commit_sha: z.string().nullable(),
    merged_at: z.string().nullable(),
    html_url: z.string().url(),
    head: z.object({ sha: z.string().regex(SHA40_PATTERN) }),
  })
  .passthrough();

interface GithubComment {
  readonly body: string;
  readonly author_association: string;
  readonly html_url: string;
}

export interface GithubRunner {
  get(path: string): unknown;
}

export function createGhRunner(): GithubRunner {
  return {
    get(path: string): unknown {
      const output = execFileSync('gh', ['api', path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return JSON.parse(output) as unknown;
    },
  };
}

interface ParsedClaim {
  readonly nodeId: string;
  readonly claimant: string;
  readonly session: string;
  readonly expiresAt: string;
  readonly claimedAt: string;
  readonly baseCommit: string;
  readonly scope: string;
  readonly url: string;
  readonly postedAt: string;
}

interface ParsedBlockedEvent {
  readonly nodeId: string;
  readonly url: string;
}

function isTrustedAuthor(comment: GithubComment): boolean {
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association);
}

function parseTrustedClaim(comment: GithubComment, expectedNodeId?: string): ParsedClaim | null {
  if (!isTrustedAuthor(comment)) return null;
  const lines = comment.body.split(/\r?\n/);
  if (lines[0]?.trim() !== 'CLAIMED') return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) fields.set(match[1], match[2]);
  }
  const nodeId = fields.get('node');
  const claimant = fields.get('claimant');
  const session = fields.get('session');
  const expiresAt = fields.get('expires_at');
  const claimedAt = fields.get('claimed_at');
  const baseCommit = fields.get('base_commit');
  const scope = fields.get('scope');
  if (
    !nodeId ||
    !claimant ||
    !session ||
    !expiresAt ||
    !claimedAt ||
    !baseCommit ||
    !scope ||
    Number.isNaN(Date.parse(expiresAt)) ||
    Number.isNaN(Date.parse(claimedAt))
  ) {
    return null;
  }
  if (expectedNodeId !== undefined && nodeId !== expectedNodeId) return null;
  return {
    nodeId,
    claimant,
    session,
    expiresAt,
    claimedAt,
    baseCommit,
    scope,
    url: comment.html_url,
    postedAt: claimedAt,
  };
}

function parseTrustedBlockedEvent(
  comment: GithubComment,
  expectedNodeId?: string,
): ParsedBlockedEvent | null {
  if (!isTrustedAuthor(comment)) return null;
  const lines = comment.body.split(/\r?\n/);
  if (lines[0]?.trim() !== 'BLOCKED') return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) fields.set(match[1], match[2]);
  }
  const nodeId = fields.get('node') ?? expectedNodeId;
  if (!nodeId) return null;
  if (expectedNodeId !== undefined && nodeId !== expectedNodeId) return null;
  return { nodeId, url: comment.html_url };
}

function findStaleHeadBoundEvidence(node: EpicNode, headSha: string): string[] {
  return node.evidence
    .filter((item) => ['handoff', 'review-ledger'].includes(item.kind) && item.commit !== headSha)
    .map((item) => item.kind)
    .sort();
}

export function auditGithub(
  state: EpicState,
  runner: GithubRunner,
  now = new Date(),
): {
  readonly errors: ReadonlyArray<Diagnostic>;
  readonly warnings: ReadonlyArray<Diagnostic>;
  readonly proposal: ReconciliationProposal;
} {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const repoPatch: RepoPatchOperation[] = [];
  const operatorActions: string[] = [];
  const [owner, repo] = state.github.repository.split('/');
  if (!owner || !repo) {
    return {
      errors: [{ code: 'github.repository', message: 'Invalid owner/repository value' }],
      warnings,
      proposal: { repo_patch: repoPatch, operator_actions: operatorActions },
    };
  }
  const issueClaims: ParsedClaim[] = [];
  const auditedIssues = new Map<number, GithubIssue>();
  const failedIssueAudits = new Set<number>();
  const proposeIssueState = (issue: GithubIssue, expectedNode?: EpicNode): void => {
    if (expectedNode && expectedNode.reconciliation.observed_issue_state !== issue.state) {
      repoPatch.push({
        op: 'replace',
        path: `/nodes/${state.nodes.indexOf(expectedNode)}/reconciliation/observed_issue_state`,
        value: issue.state,
        reason: `Observed issue #${issue.number} state from GitHub`,
      });
    }
  };
  const auditIssue = (issueNumber: number, expectedNode?: EpicNode): void => {
    const cached = auditedIssues.get(issueNumber);
    if (cached) {
      proposeIssueState(cached, expectedNode);
      return;
    }
    try {
      const issue = issueRefSchema
        .extend({ state: z.enum(['open', 'closed']), html_url: z.string().url() })
        .passthrough()
        .parse(runner.get(`/repos/${owner}/${repo}/issues/${issueNumber}`)) as GithubIssue;
      auditedIssues.set(issueNumber, issue);
      proposeIssueState(issue, expectedNode);
      const commentSchema = z
        .object({
          body: z.string(),
          author_association: z.string(),
          html_url: z.string().url(),
        })
        .passthrough();
      const comments: GithubComment[] = [];
      for (let page = 1; ; page += 1) {
        const batch = z
          .array(commentSchema)
          .parse(
            runner.get(
              `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
            ),
          ) as GithubComment[];
        comments.push(...batch);
        if (batch.length < 100) break;
      }
      // Fold CLAIMED and BLOCKED events in chronological order (comments arrive oldest-first).
      // A BLOCKED event revokes the live claim set for that node, but a later CLAIMED
      // comment can re-establish ownership in the same thread.
      const latestClaimsByNodeAndOwner = new Map<string, Map<string, ParsedClaim>>();
      const latestRevokeByNode = new Map<string, { nodeId: string; url: string }>();
      const expectedNodeId = expectedNode?.node_id ?? state.claim_policy.bootstrap_node;
      for (const comment of comments) {
        const blocked = parseTrustedBlockedEvent(comment, expectedNodeId);
        if (blocked) {
          latestClaimsByNodeAndOwner.delete(blocked.nodeId);
          latestRevokeByNode.set(blocked.nodeId, blocked);
          continue;
        }
        const claim = parseTrustedClaim(comment, expectedNodeId);
        if (claim) {
          const perOwner =
            latestClaimsByNodeAndOwner.get(claim.nodeId) ?? new Map<string, ParsedClaim>();
          const ownerKey = `${claim.claimant}\u0000${claim.session}`;
          const prior = perOwner.get(ownerKey);
          if (!prior || Date.parse(claim.claimedAt) > Date.parse(prior.claimedAt)) {
            perOwner.set(ownerKey, claim);
          }
          latestClaimsByNodeAndOwner.set(claim.nodeId, perOwner);
        }
      }
      const nodesById = new Map(state.nodes.map((n) => [n.node_id, n]));
      for (const [revokedNodeId, blocked] of latestRevokeByNode) {
        const cacheNode = nodesById.get(revokedNodeId);
        const cacheStillClaimed =
          cacheNode !== undefined &&
          ACTIVE_STATUSES.has(cacheNode.status) &&
          cacheNode.ownership.claimant !== null &&
          cacheNode.ownership.session !== null;
        if (cacheStillClaimed && !latestClaimsByNodeAndOwner.has(revokedNodeId)) {
          operatorActions.push(
            `Ownership of ${revokedNodeId} was revoked by a BLOCKED event (${blocked.url}). ` +
              `Verify cached ownership reflects the revocation or a subsequent re-claim.`,
          );
        }
      }
      for (const ownerMap of latestClaimsByNodeAndOwner.values()) {
        for (const claim of ownerMap.values()) {
          if (Date.parse(claim.expiresAt) > now.getTime()) {
            issueClaims.push(claim);
          }
        }
      }
    } catch (error) {
      failedIssueAudits.add(issueNumber);
      errors.push({
        code: 'github.issue-audit',
        node_id: expectedNode?.node_id,
        message: `Could not audit issue #${issueNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  };

  if (state.github.parent_issue) auditIssue(state.github.parent_issue.number);
  for (const node of state.nodes) {
    if (node.github.issue) auditIssue(node.github.issue.number, node);
    const stackedIssue = node.stacked_work?.issue;
    const mainIssue = node.github.issue;
    if (stackedIssue && stackedIssue.number !== mainIssue?.number) {
      auditIssue(stackedIssue.number, node);
    }
    if (!node.github.pr) continue;
    try {
      const pull = githubPullSchema.parse(
        runner.get(`/repos/${owner}/${repo}/pulls/${node.github.pr.number}`),
      ) as GithubPull;
      const observedState = pull.merged ? 'MERGED' : pull.state.toUpperCase();
      const observedMergeCommit = pull.merged ? pull.merge_commit_sha : null;
      if (node.status === 'pr_open' && pull.head.sha !== node.github.pr.head_sha) {
        const staleEvidenceKinds = findStaleHeadBoundEvidence(node, pull.head.sha);
        if (staleEvidenceKinds.length > 0) {
          errors.push({
            code: 'github.stale-pr-evidence',
            node_id: node.node_id,
            message:
              `${node.node_id} PR #${pull.number} head advanced to ${pull.head.sha}, ` +
              `but ${staleEvidenceKinds.join(', ')} evidence is still pinned to an older commit`,
          });
          operatorActions.push(
            `Refresh ${node.node_id} handoff/review-ledger evidence for PR #${pull.number} at ` +
              `${pull.head.sha}, then update cached PR head facts.`,
          );
        } else {
          repoPatch.push({
            op: 'replace',
            path: `/nodes/${state.nodes.indexOf(node)}/github/pr/head_sha`,
            value: pull.head.sha,
            reason: `Observed PR #${pull.number} head advanced on GitHub`,
          });
        }
      }
      if (node.status === 'merged' || node.status === 'validated') {
        if (!pull.merged || pull.merge_commit_sha !== node.merge.commit) {
          errors.push({
            code: 'github.merge-drift',
            node_id: node.node_id,
            message: `${node.node_id} cached merge facts disagree with GitHub`,
          });
        } else if (pull.merged_at !== node.merge.merged_at) {
          repoPatch.push({
            op: 'replace',
            path: `/nodes/${state.nodes.indexOf(node)}/merge/merged_at`,
            value: pull.merged_at,
            reason: `GitHub merge timestamp for PR #${pull.number}`,
          });
        }
      }
      if (node.status === 'pr_open') {
        if (pull.merged && pull.merge_commit_sha) {
          operatorActions.push(
            `PR #${pull.number} for ${node.node_id} is merged on GitHub ` +
              `(sha: ${pull.merge_commit_sha}, merged_at: ${pull.merged_at ?? 'unknown'}). ` +
              `Producer must verify and update ${node.node_id} to merged status with these facts.`,
          );
        } else if (!pull.merged && pull.state === 'closed') {
          operatorActions.push(
            `PR #${pull.number} for ${node.node_id} is closed without merging. ` +
              `Producer must investigate and update ${node.node_id} status accordingly.`,
          );
        }
      }
      if (node.reconciliation.observed_pr_state !== observedState) {
        repoPatch.push({
          op: 'replace',
          path: `/nodes/${state.nodes.indexOf(node)}/reconciliation/observed_pr_state`,
          value: observedState,
          reason: `Observed PR #${pull.number} state from GitHub`,
        });
      }
      if (node.reconciliation.observed_head_sha !== pull.head.sha) {
        repoPatch.push({
          op: 'replace',
          path: `/nodes/${state.nodes.indexOf(node)}/reconciliation/observed_head_sha`,
          value: pull.head.sha,
          reason: `Observed PR #${pull.number} head from GitHub`,
        });
      }
      if (node.reconciliation.observed_merge_commit !== observedMergeCommit) {
        repoPatch.push({
          op: 'replace',
          path: `/nodes/${state.nodes.indexOf(node)}/reconciliation/observed_merge_commit`,
          value: observedMergeCommit,
          reason: `Observed PR #${pull.number} merge commit from GitHub`,
        });
      }
    } catch (error) {
      errors.push({
        code: 'github.pr-audit',
        node_id: node.node_id,
        message: `Could not audit PR #${node.github.pr.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  // Audit speculative stacked-work PRs (stacked_pr_open mode).
  // Proposes head-SHA updates and flags merged/closed speculative PRs for Producer attention.
  const prSchema = z
    .object({
      number: z.number().int().positive(),
      state: z.enum(['open', 'closed']),
      merged: z.boolean(),
      merge_commit_sha: z.string().nullable(),
      merged_at: z.string().nullable(),
      html_url: z.string().url(),
      head: z.object({ sha: z.string().regex(SHA40_PATTERN) }),
    })
    .passthrough();
  for (const node of state.nodes) {
    const sw = node.stacked_work;
    if (!sw?.pr) continue;
    try {
      const pull = prSchema.parse(
        runner.get(`/repos/${owner}/${repo}/pulls/${sw.pr.number}`),
      ) as GithubPull;
      if (pull.head.sha !== sw.pr.head_sha) {
        repoPatch.push({
          op: 'replace',
          path: `/nodes/${state.nodes.indexOf(node)}/stacked_work/pr/head_sha`,
          value: pull.head.sha,
          reason: `Observed speculative PR #${pull.number} head advanced on GitHub`,
        });
      }
      if (pull.merged && pull.merge_commit_sha) {
        operatorActions.push(
          `Speculative PR #${pull.number} for ${node.node_id} is merged on GitHub ` +
            `(sha: ${pull.merge_commit_sha}, merged_at: ${pull.merged_at ?? 'unknown'}). ` +
            'Producer must verify rebase-to-main is complete, clear stacked_work, and advance through normal lifecycle.',
        );
      } else if (!pull.merged && pull.state === 'closed') {
        operatorActions.push(
          `Speculative PR #${pull.number} for ${node.node_id} is closed without merging. ` +
            'Producer must investigate and update stacked_work status accordingly.',
        );
      }
    } catch (error) {
      errors.push({
        code: 'github.stacked-pr-audit',
        node_id: node.node_id,
        message: `Could not audit speculative PR #${sw.pr.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  // Group live claims by node to detect competing claimants.
  // Within auditIssue, same-session heartbeat replacement is already collapsed.
  const deduplicatedByNode = new Map<string, ParsedClaim[]>();
  const deduplicatedByOwner = new Map<string, ParsedClaim[]>();
  for (const claim of issueClaims) {
    const byNode = deduplicatedByNode.get(claim.nodeId) ?? [];
    byNode.push(claim);
    deduplicatedByNode.set(claim.nodeId, byNode);
    const sessionKey = `${claim.claimant}\u0000${claim.session}`;
    const byOwner = deduplicatedByOwner.get(sessionKey) ?? [];
    byOwner.push(claim);
    deduplicatedByOwner.set(sessionKey, byOwner);
  }
  const nodesById = new Map(state.nodes.map((n) => [n.node_id, n]));
  for (const node of state.nodes) {
    if (!ACTIVE_STATUSES.has(node.status)) continue;
    if (!node.ownership.claimant || !node.ownership.session) continue;
    const ownershipIssueNumber = node.github.issue?.number ?? state.github.parent_issue?.number;
    if (ownershipIssueNumber && failedIssueAudits.has(ownershipIssueNumber)) continue;
    if (deduplicatedByNode.has(node.node_id)) continue;
    errors.push({
      code: 'github.missing-live-claim',
      node_id: node.node_id,
      message:
        `${node.node_id} is ${node.status} with cached owner ` +
        `${node.ownership.claimant}/${node.ownership.session}, but no live trusted CLAIMED comment exists`,
    });
    operatorActions.push(
      `Post a fresh trusted CLAIMED comment for ${node.node_id} or clear cached ownership ` +
        `before continuing active work.`,
    );
  }
  for (const [nodeId, claims] of deduplicatedByNode) {
    if (claims.length > 1) {
      errors.push({
        code: 'github.duplicate-live-claims',
        node_id: nodeId,
        message: `${nodeId} has ${claims.length} live trusted CLAIMED comments from competing claimants`,
      });
      operatorActions.push(
        `Resolve duplicate live claims for ${nodeId}: ${claims.map((claim) => claim.url).join(', ')}`,
      );
    }
    // Reconcile the single authoritative live claim against cached ownership.
    if (claims.length === 1) {
      const liveClaim = claims[0]!;
      const epicNode = nodesById.get(nodeId);
      if (epicNode && ACTIVE_STATUSES.has(epicNode.status)) {
        const owns = epicNode.ownership;
        const ownerIdentityDrifts: string[] = [];
        if (liveClaim.claimant !== owns.claimant) {
          ownerIdentityDrifts.push(`claimant: ${liveClaim.claimant} vs ${owns.claimant ?? 'none'}`);
        }
        if (liveClaim.session !== owns.session) {
          ownerIdentityDrifts.push(`session: ${liveClaim.session} vs ${owns.session ?? 'none'}`);
        }
        if (ownerIdentityDrifts.length > 0) {
          operatorActions.push(
            `Live claim on ${nodeId} differs from cached ownership (${ownerIdentityDrifts.join('; ')}). ` +
              `Producer must verify and reconcile ${nodeId} ownership.`,
          );
        } else {
          // Same owner/session — reconcile authoritative ownership fields that may have
          // advanced (e.g. a heartbeat post with a newer expiry, scope, or base commit).
          const nodeIdx = state.nodes.indexOf(epicNode);
          if (liveClaim.expiresAt !== owns.lease_expires_at) {
            repoPatch.push({
              op: 'replace',
              path: `/nodes/${nodeIdx}/ownership/lease_expires_at`,
              value: liveClaim.expiresAt,
              reason: `Live CLAIMED comment has newer expiry for ${nodeId}`,
            });
          }
          if (liveClaim.scope !== owns.scope) {
            repoPatch.push({
              op: 'replace',
              path: `/nodes/${nodeIdx}/ownership/scope`,
              value: liveClaim.scope,
              reason: `Live CLAIMED comment has updated scope for ${nodeId}`,
            });
          }
          if (liveClaim.baseCommit !== owns.base_commit) {
            repoPatch.push({
              op: 'replace',
              path: `/nodes/${nodeIdx}/ownership/base_commit`,
              value: liveClaim.baseCommit,
              reason: `Live CLAIMED comment has updated base_commit for ${nodeId}`,
            });
          }
          if (liveClaim.claimedAt !== owns.claimed_at) {
            repoPatch.push({
              op: 'replace',
              path: `/nodes/${nodeIdx}/ownership/claimed_at`,
              value: liveClaim.claimedAt,
              reason: `Live CLAIMED comment has updated claimed_at for ${nodeId}`,
            });
          }
          // postedAt from the live claim is the most recent heartbeat timestamp.
          if (liveClaim.postedAt !== owns.heartbeat_at) {
            repoPatch.push({
              op: 'replace',
              path: `/nodes/${nodeIdx}/ownership/heartbeat_at`,
              value: liveClaim.postedAt,
              reason: `Live CLAIMED comment heartbeat for ${nodeId}`,
            });
          }
        }
      } else if (epicNode && !ACTIVE_STATUSES.has(epicNode.status)) {
        operatorActions.push(
          `Issue has a live CLAIMED comment for ${nodeId} but cached status is ${epicNode.status}. ` +
            `Producer must verify whether this claim is stale or if the cache needs updating.`,
        );
      }
    }
  }
  for (const claims of deduplicatedByOwner.values()) {
    const nodes = new Set(claims.map((claim) => claim.nodeId));
    if (nodes.size > 1) {
      warnings.push({
        code: 'github.owner-overlap',
        message: `${claims[0]?.claimant}/${claims[0]?.session} has live claims on ${[...nodes].join(', ')}`,
      });
      operatorActions.push(
        `Producer must confirm non-overlapping scope or release claims for ${[...nodes].join(', ')}.`,
      );
    }
  }
  return {
    errors,
    warnings,
    proposal: { repo_patch: repoPatch, operator_actions: operatorActions },
  };
}

export function applyGithubAudit(
  offline: ValidationResult,
  audit: {
    readonly errors: ReadonlyArray<Diagnostic>;
    readonly warnings: ReadonlyArray<Diagnostic>;
    readonly proposal: ReconciliationProposal;
  },
): ValidationResult {
  const errors = [...offline.errors, ...audit.errors];
  return {
    state: offline.state,
    errors,
    warnings: [...offline.warnings, ...audit.warnings],
    blockers: offline.blockers,
    // GitHub facts are stronger authority than offline validation.
    // Mirror the offline validator's own behaviour: suppress the queue when
    // the stronger-authority source contributes errors so the caller never
    // surfaces dispatchable nodes while the audit is invalid.
    ready_queue: audit.errors.length > 0 ? [] : offline.ready_queue,
    release_ready: offline.release_ready && errors.length === 0,
    proposal: {
      repo_patch: [...offline.proposal.repo_patch, ...audit.proposal.repo_patch],
      operator_actions: [...offline.proposal.operator_actions, ...audit.proposal.operator_actions],
    },
  };
}

export function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, 'package.json')) && existsSync(resolve(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not locate repository root from ${start}`);
    }
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Materialization — write side
// ---------------------------------------------------------------------------

/** A runner that can both read and create GitHub resources. */
export interface GithubWriteRunner extends GithubRunner {
  /**
   * POST to a GitHub API path with a JSON payload.
   * Returns the parsed JSON response.
   */
  post(path: string, payload: unknown): unknown;
}

export function createGhWriteRunner(): GithubWriteRunner {
  return {
    get(path: string): unknown {
      const output = execFileSync('gh', ['api', path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return JSON.parse(output) as unknown;
    },
    post(path: string, payload: unknown): unknown {
      const body = JSON.stringify(payload);
      const output = execFileSync('gh', ['api', '--method', 'POST', path, '--input', '-'], {
        encoding: 'utf8',
        input: body,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return JSON.parse(output) as unknown;
    },
  };
}

/** Outcome for a single materialization packet. */
export interface MaterializationOutcome {
  readonly node_id: string;
  readonly title: string;
  /** 'created' — new issue was created; 'existing' — issue already exists (skipped); 'dry-run' — no write performed. */
  readonly status: 'created' | 'existing' | 'dry-run';
  readonly issue_number: number | null;
  readonly issue_url: string | null;
}

export interface MaterializationResult {
  readonly outcomes: ReadonlyArray<MaterializationOutcome>;
  readonly created_count: number;
  readonly existing_count: number;
  readonly dry_run: boolean;
}

/** Shape of the GitHub API response for a created or listed issue. */
const githubIssueApiSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    title: z.string(),
    body: z.string().nullable().optional(),
    /** Present on pull requests; absent on plain issues. */
    pull_request: z.unknown().optional(),
  })
  .passthrough();

/** The `Node: \`<node_id>\`` marker embedded in every materialized issue body. */
const NODE_MARKER_PATTERN = /^Node:\s*`([^`]+)`/m;

/**
 * Extract the node_id from an issue body via the stable `Node: \`slice:...\`` marker.
 * Returns null if the marker is absent or does not match the NODE_ID_PATTERN.
 */
function extractNodeIdFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = NODE_MARKER_PATTERN.exec(body);
  if (!match?.[1]) return null;
  return NODE_ID_PATTERN.test(match[1]) ? match[1] : null;
}

/**
 * List all issues in the repo (open or closed) that carry every label in
 * `labels`. Uses `gh api` with `state=all` and paginates (`page=N`,
 * `per_page=100`) until completion so previously-created (including closed)
 * issues are detected and duplicates are prevented.
 */
function listIssuesByLabels(
  runner: GithubRunner,
  repo: string,
  labels: ReadonlyArray<string>,
): Array<{ number: number; title: string; html_url: string; body: string | null }> {
  const labelParam = encodeURIComponent(labels.join(','));
  const allIssues: Array<{ number: number; title: string; html_url: string; body: string | null }> = [];
  for (let page = 1; ; page++) {
    const path = `/repos/${repo}/issues?state=all&labels=${labelParam}&per_page=100&page=${page}`;
    const raw = runner.get(path);
    const parsed = z.array(githubIssueApiSchema).safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `GitHub API returned unexpected issue list shape (page ${page}): ${parsed.error.message}`,
      );
    }
    // Filter out pull requests — the Issues API can return PRs for the same labels.
    const issues = parsed.data.filter((item) => item.pull_request === undefined);
    allIssues.push(
      ...issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        html_url: issue.html_url,
        body: issue.body ?? null,
      })),
    );
    if (parsed.data.length < 100) break;
  }
  return allIssues;
}

/**
 * Materialize child issues for the given epic state.
 *
 * In dry-run mode (`options.dryRun === true`) no GitHub writes are performed
 * and no state file is mutated. Returns an outcome with status `'dry-run'` for
 * each planned packet.
 *
 * In write mode (`options.dryRun === false`) each packet is matched against
 * existing issues first by the stable `Node: \`<node_id>\`` body marker, then
 * by exact title as a fallback. If a match is found the issue is recorded as
 * `'existing'` (no write); otherwise a new issue is created and recorded as
 * `'created'`. The caller is responsible for persisting the resulting issue map
 * to `epic-state.json` via `patchEpicStateIssues`.
 */
export function materializeChildIssues(
  state: EpicState,
  runner: GithubWriteRunner,
  options: { readonly dryRun: boolean },
): MaterializationResult {
  const plan = buildMaterializationPlan(state);
  const repo = state.github.repository;

  if (options.dryRun || plan.length === 0) {
    return {
      outcomes: plan.map((packet) => ({
        node_id: packet.node_id,
        title: packet.title,
        status: 'dry-run',
        issue_number: null,
        issue_url: null,
      })),
      created_count: 0,
      existing_count: 0,
      dry_run: options.dryRun,
    };
  }

  // Fetch existing issues once to enable idempotency checks.
  const existingIssues = listIssuesByLabels(runner, repo, state.issue_materialization.labels);
  // Primary key: stable node_id extracted from the `Node: \`...\`` body marker.
  const existingByNodeId = new Map<
    string,
    { number: number; title: string; html_url: string; body: string | null }
  >();
  // Fallback key: exact title match (covers issues created before the marker convention).
  const existingByTitle = new Map<
    string,
    { number: number; title: string; html_url: string; body: string | null }
  >();
  for (const issue of existingIssues) {
    const nodeId = extractNodeIdFromBody(issue.body);
    if (nodeId) existingByNodeId.set(nodeId, issue);
    // Title fallback is legacy-only: once an issue has a stable Node marker,
    // it must be matched by marker to prevent cross-node collisions.
    if (!nodeId) existingByTitle.set(issue.title, issue);
  }

  const outcomes: MaterializationOutcome[] = [];
  let createdCount = 0;
  let existingCount = 0;

  for (const packet of plan) {
    // Match by stable node_id marker first, then fall back to title.
    const existing = existingByNodeId.get(packet.node_id) ?? existingByTitle.get(packet.title);
    if (existing) {
      outcomes.push({
        node_id: packet.node_id,
        title: packet.title,
        status: 'existing',
        issue_number: existing.number,
        issue_url: existing.html_url,
      });
      existingCount++;
      continue;
    }

    // Create the issue via gh api POST.
    const payload = {
      title: packet.title,
      body: packet.body,
      labels: [...packet.labels],
    };
    const raw = runner.post(`/repos/${repo}/issues`, payload);
    const parsed = githubIssueApiSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `GitHub API returned unexpected shape for new issue (node ${packet.node_id}): ${JSON.stringify(raw)}`,
      );
    }
    outcomes.push({
      node_id: packet.node_id,
      title: packet.title,
      status: 'created',
      issue_number: parsed.data.number,
      issue_url: parsed.data.html_url,
    });
    createdCount++;
  }

  return {
    outcomes,
    created_count: createdCount,
    existing_count: existingCount,
    dry_run: false,
  };
}

/**
 * Atomically patch `epic-state.json` to record newly created (or discovered)
 * child issue numbers for the given node IDs.
 *
 * `issueMap` maps `node_id → { number, url }`. Only nodes present in the map
 * are updated; existing issue fields are never overwritten.
 */
export function patchEpicStateIssues(
  repoRoot: string,
  epicId: string,
  issueMap: ReadonlyMap<string, { readonly number: number; readonly url: string }>,
): void {
  if (issueMap.size === 0) return;
  const stateFilePath = resolve(repoRoot, 'docs', 'knowledge', 'epics', epicId, 'epic-state.json');
  const raw = JSON.parse(readFileSync(stateFilePath, 'utf8')) as Record<string, unknown>;
  const nodes = raw['nodes'];
  if (!Array.isArray(nodes)) {
    throw new Error('epic-state.json is missing a top-level "nodes" array');
  }
  for (const node of nodes as Array<Record<string, unknown>>) {
    const nodeId = node['node_id'];
    if (typeof nodeId !== 'string') continue;
    const entry = issueMap.get(nodeId);
    if (!entry) continue;
    const github = node['github'];
    if (!github || typeof github !== 'object') continue;
    const gh = github as Record<string, unknown>;
    // Never overwrite an existing issue entry.
    if (gh['issue'] !== null && gh['issue'] !== undefined) continue;
    gh['issue'] = { number: entry.number, url: entry.url };
  }
  const tempPath = `${stateFilePath}.tmp-${process.pid}-${randomUUID()}`;
  let tempWritten = false;
  try {
    writeFileSync(tempPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    tempWritten = true;
    renameSync(tempPath, stateFilePath);
    tempWritten = false;
  } finally {
    if (tempWritten) {
      try {
        unlinkSync(tempPath);
      } catch {
        // best-effort cleanup only
      }
    }
  }
}
