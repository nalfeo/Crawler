import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

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

/**
 * Canonical dependency edges for the Floor 2 equipment epic DAG.
 * Derived from the approved execution graph in PLAN.md.
 * Any change to these edges requires the plan-change protocol.
 */
const CANONICAL_DEPENDENCIES: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['slice:A0', []],
  ['slice:A1', ['slice:A0']],
  ['slice:B1', ['slice:A1']],
  ['slice:B2', ['slice:B1']],
  ['slice:B3', ['slice:B2']],
  ['slice:C1', ['slice:A1']],
  ['slice:C2', ['slice:C1', 'slice:B3']],
  ['slice:D1', ['slice:A1']],
  ['packet:D2-A', ['slice:D1', 'slice:B1']],
  ['packet:D2-B', ['slice:D1', 'slice:C1']],
  ['slice:D2', ['packet:D2-A', 'packet:D2-B']],
  ['packet:D3-A', ['slice:D2', 'slice:B2']],
  ['packet:D3-B', ['slice:D2', 'slice:C1']],
  ['slice:D3', ['packet:D3-A', 'packet:D3-B']],
  ['slice:E1', ['slice:A1']],
  ['slice:E2', ['slice:E1', 'slice:C1']],
  ['packet:E3-A', ['slice:E2', 'slice:B2']],
  ['packet:E3-B', ['slice:E2', 'slice:D2']],
  ['packet:E3-C', ['slice:E2', 'slice:C1']],
  ['slice:E3', ['packet:E3-A', 'packet:E3-B', 'packet:E3-C']],
  ['slice:F1', ['slice:B1', 'slice:C1']],
  ['slice:F2', ['slice:F1', 'slice:B2']],
  ['slice:F3', ['slice:F2', 'slice:E2']],
  ['slice:F4', ['slice:F3', 'slice:C2']],
  ['slice:G1', ['slice:A1']],
  ['packet:G2-A', ['slice:G1', 'slice:C1']],
  ['packet:G2-B+', ['slice:G1', 'slice:B2']],
  ['slice:G2', ['packet:G2-A', 'packet:G2-B+']],
  ['packet:G3', ['slice:G2', 'slice:D3']],
  ['slice:G3', ['packet:G3']],
  ['slice:H1', ['slice:C1', 'slice:F1']],
  ['slice:H2', ['slice:H1', 'slice:G2']],
  ['slice:H3', ['slice:H2', 'slice:G3']],
  [
    'slice:I1',
    ['slice:B3', 'slice:C2', 'slice:D3', 'slice:E3', 'slice:F4', 'slice:G3', 'slice:H3'],
  ],
  ['slice:I2', ['slice:I1']],
  ['slice:I3', ['slice:I2']],
  ['slice:J', ['slice:I3']],
]);

/**
 * Canonical parent-slice assignments for cloud packets.
 * A null value means the node is a slice with no parent.
 */
const CANONICAL_PARENT_SLICES: ReadonlyMap<string, string | null> = new Map([
  ['slice:A0', null],
  ['slice:A1', null],
  ['slice:B1', null],
  ['slice:B2', null],
  ['slice:B3', null],
  ['slice:C1', null],
  ['slice:C2', null],
  ['slice:D1', null],
  ['packet:D2-A', 'slice:D2'],
  ['packet:D2-B', 'slice:D2'],
  ['slice:D2', null],
  ['packet:D3-A', 'slice:D3'],
  ['packet:D3-B', 'slice:D3'],
  ['slice:D3', null],
  ['slice:E1', null],
  ['slice:E2', null],
  ['packet:E3-A', 'slice:E3'],
  ['packet:E3-B', 'slice:E3'],
  ['packet:E3-C', 'slice:E3'],
  ['slice:E3', null],
  ['slice:F1', null],
  ['slice:F2', null],
  ['slice:F3', null],
  ['slice:F4', null],
  ['slice:G1', null],
  ['packet:G2-A', 'slice:G2'],
  ['packet:G2-B+', 'slice:G2'],
  ['slice:G2', null],
  ['packet:G3', 'slice:G3'],
  ['slice:G3', null],
  ['slice:H1', null],
  ['slice:H2', null],
  ['slice:H3', null],
  ['slice:I1', null],
  ['slice:I2', null],
  ['slice:I3', null],
  ['slice:J', null],
]);

const nullableDateTime = z.string().datetime({ offset: true }).nullable();
const nullableSha = z.string().regex(SHA_PATTERN).nullable();
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
    claimant: z.string().nullable(),
    session: z.string().nullable(),
    source: z.enum(['none', 'parent-issue-bootstrap', 'child-issue-comment']),
    scope: z.string().nullable(),
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
        flags: z
          .array(
            z
              .object({
                name: z.string().min(1),
                default: z.literal(false),
                validating_nodes: z
                  .array(z.string().regex(/^slice:/))
                  .min(1)
                  .superRefine(uniqueStringItems),
              })
              .strict(),
          )
          .min(7),
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
  showContent(commit: string, filePath: string): string | null;
  commitExists(commit: string): boolean;
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

function gitCommitExists(repoRoot: string, commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', commit], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the production GitReader that shells out to real git commands.
 * Used by `loadAndValidateEpic` and the CLI. In unit tests, inject a custom
 * implementation (e.g. a working-tree reader) via `ValidationOptions.gitReader`
 * to avoid depending on full git history being present in the checkout.
 */
export function createDefaultGitReader(repoRoot: string): GitReader {
  return {
    showContent(commit: string, filePath: string): string | null {
      return gitShowContent(repoRoot, commit, filePath);
    },
    commitExists(commit: string): boolean {
      return gitCommitExists(repoRoot, commit);
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

function validateCommittedSchema(schemaDocument: unknown, result: MutableValidation): void {
  const schema = z
    .object({
      $schema: z.literal('https://json-schema.org/draft/2020-12/schema'),
      $id: z.string().url(),
      properties: z
        .object({
          schema_version: z.object({ const: z.literal('crawler-epic-state/v1') }),
          epic_id: z.object({ const: z.literal('floor-2-equipment') }),
          nodes: z.object({ minItems: z.literal(37) }).passthrough(),
          release: z
            .object({
              properties: z
                .object({ flags: z.object({ minItems: z.literal(7) }).passthrough() })
                .passthrough(),
            })
            .passthrough(),
          authority: z
            .object({
              properties: z
                .object({
                  ordered_sources: z.object({ minItems: z.literal(4) }).passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
          lifecycle: z
            .object({
              properties: z
                .object({
                  normal: z.object({ minItems: z.literal(7) }).passthrough(),
                  terminal: z.object({ minItems: z.literal(2) }).passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
          claim_policy: z
            .object({
              properties: z
                .object({
                  protocol_headings: z.object({ minItems: z.literal(6) }).passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
        })
        .passthrough(),
      $defs: z
        .object({
          node: z.object({ type: z.literal('object') }).passthrough(),
          issueRef: z
            .object({
              properties: z
                .object({
                  url: z
                    .object({ pattern: z.string().includes('nalfeo/Crawler/issues') })
                    .passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
          prRef: z
            .object({
              properties: z
                .object({
                  url: z
                    .object({ pattern: z.string().includes('nalfeo/Crawler/pull') })
                    .passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
          stackBase: z.object({ type: z.literal('object') }).passthrough(),
          stackedWork: z.object({ type: z.literal('object') }).passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .safeParse(schemaDocument);
  if (!schema.success) {
    result.errors.push({
      code: 'schema.invalid',
      message: schema.error.issues.map(formatZodIssue).join('; '),
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
    (node.stacked_work === null || node.stacked_work === undefined) &&
    dependenciesSatisfied(node, nodesById) &&
    hasIssueAuthority(state, node)
  );
}

function validateDag(
  state: EpicState,
  nodesById: ReadonlyMap<string, EpicNode>,
  result: MutableValidation,
): void {
  const expected = new Set<string>(EXPECTED_NODE_IDS);
  const actual = new Set<string>();
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

  // Validate that dependencies and parent_slice exactly match the canonical plan graph.
  for (const node of state.nodes) {
    const canonicalDeps = CANONICAL_DEPENDENCIES.get(node.node_id);
    if (canonicalDeps !== undefined) {
      const actual = [...node.dependencies].sort();
      const expected = [...canonicalDeps].sort();
      if (actual.join('\u0000') !== expected.join('\u0000')) {
        result.errors.push({
          code: 'dag.dependency-contract-drift',
          node_id: node.node_id,
          message:
            `${node.node_id} dependencies [${actual.join(', ')}] do not match ` +
            `canonical plan [${expected.join(', ')}]`,
        });
      }
    }
    const canonicalParent = CANONICAL_PARENT_SLICES.get(node.node_id);
    if (canonicalParent !== undefined && node.parent_slice !== canonicalParent) {
      result.errors.push({
        code: 'dag.parent-slice-contract-drift',
        node_id: node.node_id,
        message:
          `${node.node_id} parent_slice ${String(node.parent_slice)} does not match ` +
          `canonical plan ${String(canonicalParent)}`,
      });
    }
  }
}

function isRepoFile(repoRoot: string, candidate: string): boolean {
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
  // Verify handoff and review-ledger evidence (required for every post-PR node).
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
    const content = gitReader.showContent(evidence.commit, evidence.path_or_check);
    if (content === null) {
      result.errors.push({
        code: 'evidence.git-verification-failed',
        node_id: node.node_id,
        message: `${node.node_id} evidence could not be verified at commit ${evidence.commit}: ${evidence.path_or_check} (commit or file may not exist)`,
      });
      continue;
    }
    const actualHash = sha256(content);
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
    // handoff and review-ledger are already verified in validateEvidenceFiles.
    if (handledKinds.has(requirement)) continue;
    // For non-canonical kinds, verify commit existence and sha256 for file-like paths.
    if (!gitReader.commitExists(evidence.commit)) {
      result.errors.push({
        code: 'evidence.git-verification-failed',
        node_id: node.node_id,
        message: `${node.node_id} evidence commit ${evidence.commit} does not exist: ${evidence.path_or_check}`,
      });
      continue;
    }
    if (!isRepoFile(repoRoot, evidence.path_or_check)) continue;
    const content = gitReader.showContent(evidence.commit, evidence.path_or_check);
    if (content === null) {
      result.errors.push({
        code: 'evidence.git-verification-failed',
        node_id: node.node_id,
        message: `${node.node_id} evidence could not be verified at commit ${evidence.commit}: ${evidence.path_or_check}`,
      });
      continue;
    }
    if (sha256(content) !== evidence.sha256) {
      result.errors.push({
        code: 'evidence.hash-drift',
        node_id: node.node_id,
        message: `${node.node_id} evidence hash drifted at commit ${evidence.commit}: ${evidence.path_or_check}`,
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
    const requiredOwnership = [
      owns.claimant,
      owns.session,
      owns.scope,
      owns.claimed_at,
      owns.lease_expires_at,
      owns.heartbeat_at,
      owns.base_commit,
    ];
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
    } else if (!gitReader.commitExists(node.merge.commit)) {
      result.errors.push({
        code: 'merge.commit-not-found',
        node_id: node.node_id,
        message: `${node.node_id} merge commit ${node.merge.commit} does not exist in git`,
      });
    }
  }
  if (node.status === 'validated') {
    validateEvidenceRequirements(repoRoot, gitReader, node, result);
  }
  if (node.status !== 'validated' && node.release_requirement === 'required') {
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
    // Validate stacked_work session and issue uniqueness.
    if (node.stacked_work) {
      const sw = node.stacked_work;
      const priorSession = stackedSessions.get(sw.session);
      if (priorSession) {
        result.errors.push({
          code: 'stacked.duplicate-session',
          node_id: node.node_id,
          message: `Stacked session ${sw.session} is active on both ${priorSession} and ${node.node_id}`,
        });
      } else {
        stackedSessions.set(sw.session, node.node_id);
      }
      const priorIssue = stackedIssues.get(sw.issue.number);
      if (priorIssue) {
        result.errors.push({
          code: 'stacked.duplicate-issue',
          node_id: node.node_id,
          message: `Stacked issue #${sw.issue.number} is assigned to both ${priorIssue} and ${node.node_id}`,
        });
      } else {
        stackedIssues.set(sw.issue.number, node.node_id);
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
    validateCommittedSchema(options.schemaDocument, result);
  }

  const planMarkdown =
    options.planMarkdown ?? readFileSync(resolve(options.repoRoot, state.plan.path), 'utf8');
  try {
    const contract = extractPlanContract(planMarkdown);
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

  const nodesById = new Map(state.nodes.map((node) => [node.node_id, node]));
  validateDag(state, nodesById, result);
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
  result.readyQueue.sort();
  const allRequiredValidated =
    result.errors.length === 0 &&
    state.nodes
      .filter((node) => node.release_requirement === 'required')
      .every((node) => node.status === 'validated');
  const allFlagNodesValidated = state.release.flags.every((flag) =>
    flag.validating_nodes.every((nodeId) => nodesById.get(nodeId)?.status === 'validated'),
  );
  const releaseReady = allRequiredValidated && allFlagNodesValidated;
  return {
    state,
    errors: result.errors,
    warnings: result.warnings,
    blockers: result.blockers,
    ready_queue: result.readyQueue,
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
        'Use structured CLAIMED, BLOCKED, UNBLOCKED, SCOPE-CHANGE-REQUEST, and HANDOFF comments.',
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
  const nodeId = fields.get('node');
  if (!nodeId) return null;
  if (expectedNodeId !== undefined && nodeId !== expectedNodeId) return null;
  return { nodeId, url: comment.html_url };
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
      // A BLOCKED event from a trusted author revokes the live claim for that node.
      // A subsequent CLAIMED event re-establishes ownership.
      // Track live claims per-node per-session so heartbeat deduplication and
      // competing-claimant detection still work correctly.
      const liveClaimsByNodeAndSession = new Map<string, Map<string, ParsedClaim>>();
      const expectedNodeId = expectedNode?.node_id ?? state.claim_policy.bootstrap_node;
      for (const comment of comments) {
        const blocked = parseTrustedBlockedEvent(comment, expectedNodeId);
        if (blocked) {
          // BLOCKED revokes all live claims for the blocked node only.
          liveClaimsByNodeAndSession.delete(blocked.nodeId);
          continue;
        }
        const claim = parseTrustedClaim(comment, expectedNodeId);
        if (claim && Date.parse(claim.expiresAt) > now.getTime()) {
          const perSession =
            liveClaimsByNodeAndSession.get(claim.nodeId) ?? new Map<string, ParsedClaim>();
          const prior = perSession.get(claim.session);
          if (!prior || Date.parse(claim.claimedAt) > Date.parse(prior.claimedAt)) {
            perSession.set(claim.session, claim);
          }
          liveClaimsByNodeAndSession.set(claim.nodeId, perSession);
        }
      }
      for (const sessionMap of liveClaimsByNodeAndSession.values()) {
        issueClaims.push(...sessionMap.values());
      }
    } catch (error) {
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
    // Audit the speculative work's own issue for existence — but without an
    // expectedNode so we do NOT emit a reconciliation patch for the node's
    // own observed_issue_state (which mirrors only the canonical github.issue).
    const stackedIssue = node.stacked_work?.issue;
    const mainIssue = node.github.issue;
    if (stackedIssue && stackedIssue.number !== mainIssue?.number) {
      auditIssue(stackedIssue.number);
    }
    if (!node.github.pr) continue;
    try {
      const pull = z
        .object({
          number: z.number().int().positive(),
          state: z.enum(['open', 'closed']),
          merged: z.boolean(),
          merge_commit_sha: z.string().nullable(),
          merged_at: z.string().nullable(),
          html_url: z.string().url(),
          head: z.object({ sha: z.string().regex(SHA40_PATTERN) }),
        })
        .passthrough()
        .parse(runner.get(`/repos/${owner}/${repo}/pulls/${node.github.pr.number}`)) as GithubPull;
      const observedState = pull.merged ? 'MERGED' : pull.state.toUpperCase();
      const observedMergeCommit = pull.merged ? pull.merge_commit_sha : null;
      if (pull.head.sha !== node.github.pr.head_sha) {
        repoPatch.push({
          op: 'replace',
          path: `/nodes/${state.nodes.indexOf(node)}/github/pr/head_sha`,
          value: pull.head.sha,
          reason: `Observed PR #${pull.number} head advanced on GitHub`,
        });
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
      const nodesById = new Map(state.nodes.map((n) => [n.node_id, n]));
      const epicNode = nodesById.get(nodeId);
      if (epicNode && ACTIVE_STATUSES.has(epicNode.status)) {
        const owns = epicNode.ownership;
        const drifts: string[] = [];
        if (liveClaim.claimant !== owns.claimant)
          drifts.push(`claimant: ${liveClaim.claimant} vs ${owns.claimant ?? 'none'}`);
        if (liveClaim.session !== owns.session)
          drifts.push(`session: ${liveClaim.session} vs ${owns.session ?? 'none'}`);
        if (liveClaim.expiresAt !== owns.lease_expires_at)
          drifts.push(`expires_at: ${liveClaim.expiresAt} vs ${owns.lease_expires_at ?? 'none'}`);
        if (liveClaim.scope !== owns.scope)
          drifts.push(`scope: ${liveClaim.scope} vs ${owns.scope ?? 'none'}`);
        if (liveClaim.baseCommit !== owns.base_commit)
          drifts.push(`base_commit: ${liveClaim.baseCommit} vs ${owns.base_commit ?? 'none'}`);
        if (liveClaim.claimedAt !== owns.claimed_at)
          drifts.push(`claimed_at: ${liveClaim.claimedAt} vs ${owns.claimed_at ?? 'none'}`);
        if (drifts.length > 0) {
          operatorActions.push(
            `Live claim on ${nodeId} differs from cached ownership (${drifts.join('; ')}). ` +
              `Producer must verify and reconcile ${nodeId} ownership.`,
          );
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
