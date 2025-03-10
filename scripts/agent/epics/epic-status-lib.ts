import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/nalfeo\/Crawler\/issues\/[1-9][0-9]*$/;
const GITHUB_PR_URL = /^https:\/\/github\.com\/nalfeo\/Crawler\/pull\/[1-9][0-9]*$/;
const nonEmptyTrimmedString = z.string().trim().min(1);
const nullableNonEmptyTrimmedString = nonEmptyTrimmedString.nullable();
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
function parseTrailingGithubNumber(url: string): number | null {
  const trailingSegment = url.split('/').at(-1);
  if (!trailingSegment) return null;
  const parsed = Number.parseInt(trailingSegment, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const stateIssueRefSchema = issueRefSchema
  .extend({
    url: z.string().regex(GITHUB_ISSUE_URL),
  })
  .superRefine((value, ctx) => {
    if (parseTrailingGithubNumber(value.url) !== value.number) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Issue URL trailing number must match number field',
      });
    }
  });
const statePrRefSchema = prRefSchema
  .extend({
    url: z.string().regex(GITHUB_PR_URL),
  })
  .superRefine((value, ctx) => {
    if (parseTrailingGithubNumber(value.url) !== value.number) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'PR URL trailing number must match number field',
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
const GITHUB_REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const stackedWorkSchema = z
  .object({
    status: z.enum(['stacked_in_progress', 'stacked_pr_open']),
    owner: z
      .object({
        claimant: z.string().min(1),
        session: z.string().min(1),
        branch: z.string().min(1),
        claimed_at: z.string().datetime({ offset: true }),
      })
      .strict(),
    dependency: z
      .object({
        node_id: z.string().regex(NODE_ID_PATTERN),
        pr_number: z.number().int().positive(),
        repository: z.string().regex(GITHUB_REPO_PATTERN),
        branch: z.string().min(1),
        head_sha: z.string().regex(SHA40_PATTERN),
      })
      .strict(),
    dependent: z
      .object({
        head_sha: z.string().regex(SHA40_PATTERN),
        pr_number: z.number().int().positive().nullable(),
      })
      .strict(),
    resync: z
      .object({
        head_sha: z.string().regex(SHA40_PATTERN),
        at: z.string().datetime({ offset: true }),
      })
      .strict(),
    rebase_to_main: z
      .object({
        state: z.enum(['pending', 'complete']),
        completed_at: nullableDateTime,
      })
      .strict(),
    material_drift: z.string().nullable(),
    block_reason: z.string().nullable(),
  })
  .strict()
  .nullable();

const STACKED_FORBIDDEN_LANES = new Set<string>(['verification']);
const STACKED_STALE_RESYNC_MS = 48 * 3_600_000;

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
    dependencies: z.array(z.string().regex(NODE_ID_PATTERN)),
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
    evidence_requirements: z.array(z.string().min(1)).min(1),
    evidence: z.array(evidenceSchema),
    reconciliation: reconciliationSchema,
    superseded_by: z.string().regex(NODE_ID_PATTERN).nullable(),
    stacked_work: stackedWorkSchema,
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
        labels: z.array(z.string().min(1)),
        late_bound_fields: z.array(z.enum(['parent_issue_number', 'child_issue_number'])),
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
              validating_nodes: z.array(z.string().regex(/^slice:/)).min(1),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentCatalog'),
              default: z.literal(false),
              validating_nodes: z.array(z.string().regex(/^slice:/)).min(1),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentRewards'),
              default: z.literal(false),
              validating_nodes: z.array(z.string().regex(/^slice:/)).min(1),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentEconomy'),
              default: z.literal(false),
              validating_nodes: z.array(z.string().regex(/^slice:/)).min(1),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentUx'),
              default: z.literal(false),
              validating_nodes: z.array(z.string().regex(/^slice:/)).min(1),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentWorld'),
              default: z.literal(false),
              validating_nodes: z.array(z.string().regex(/^slice:/)).min(1),
            })
            .strict(),
          z
            .object({
              name: z.literal('floor2EquipmentAiMaintenance'),
              default: z.literal(false),
              validating_nodes: z.array(z.string().regex(/^slice:/)).min(1),
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
  })
  .strict();

export type EpicState = z.infer<typeof epicStateSchema>;
export type EpicNode = EpicState['nodes'][number];
type EvidenceRecord = EpicNode['evidence'][number];

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
  commitStatus?(commit: string): 'missing' | 'not-a-commit' | 'commit';
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

function gitCommitStatus(repoRoot: string, commit: string): 'missing' | 'not-a-commit' | 'commit' {
  try {
    return execFileSync('git', ['cat-file', '-t', commit], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'commit'
      ? 'commit'
      : 'not-a-commit';
  } catch {
    return 'missing';
  }
}

function validateEvidenceRecord(
  repoRoot: string,
  gitReader: GitReader,
  node: EpicNode,
  evidence: EvidenceRecord,
  result: MutableValidation,
): void {
  const canonicalDir = EVIDENCE_CANONICAL_DIRS[evidence.kind];
  if (canonicalDir && !evidence.path_or_check.startsWith(canonicalDir)) {
    result.errors.push({
      code: 'evidence.non-canonical-path',
      node_id: node.node_id,
      message: `${node.node_id} ${evidence.kind} evidence must be under ${canonicalDir}`,
    });
    return;
  }
  if (!isRepoFile(repoRoot, evidence.path_or_check)) {
    result.errors.push({
      code: 'evidence.unsafe-path',
      node_id: node.node_id,
      message: `${node.node_id} evidence path is outside the repository`,
    });
    return;
  }
  const content = gitReader.showContent(evidence.commit, evidence.path_or_check);
  if (content === null) {
    result.errors.push({
      code: 'evidence.git-verification-failed',
      node_id: node.node_id,
      message:
        `${node.node_id} evidence could not be verified at commit ${evidence.commit}: ` +
        `${evidence.path_or_check} (commit or file may not exist)`,
    });
    return;
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
      return gitCommitStatus(repoRoot, commit) === 'commit';
    },
    commitStatus(commit: string): 'missing' | 'not-a-commit' | 'commit' {
      return gitCommitStatus(repoRoot, commit);
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
                  protocol_headings: z.object({ minItems: z.literal(5) }).passthrough(),
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
    return; // schema document is malformed; cannot apply it to the manifest
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
        .map((e) => `${e.dataPath || '.'}: ${e.message}`)
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
  return (
    node.release_requirement === 'required' &&
    !TERMINAL_STATUSES.has(node.status) &&
    !POST_PR_STATUSES.has(node.status) &&
    !ACTIVE_STATUSES.has(node.status) &&
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
  for (const kind of ['handoff', 'review-ledger']) {
    const evidence = node.evidence.find((item) => item.kind === kind);
    if (!evidence) {
      result.errors.push({
        code: `evidence.missing-${kind}`,
        node_id: node.node_id,
        message: `${node.node_id} at ${node.status} requires ${kind} evidence`,
      });
    }
  }
  for (const evidence of node.evidence) {
    validateEvidenceRecord(repoRoot, gitReader, node, evidence, result);
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
      const commitStatus = gitReader.commitStatus?.(node.merge.commit);
      if (commitStatus === 'not-a-commit') {
        result.errors.push({
          code: 'merge.not-a-commit',
          node_id: node.node_id,
          message: `${node.node_id} merge commit ${node.merge.commit} exists in git but is not a commit object`,
        });
      } else if (
        commitStatus === 'missing' ||
        (commitStatus === undefined && !gitReader.commitExists(node.merge.commit))
      ) {
        result.errors.push({
          code: 'merge.commit-not-found',
          node_id: node.node_id,
          message: `${node.node_id} merge commit ${node.merge.commit} does not exist in git`,
        });
      }
    }
  }
  if (node.status === 'validated') {
    const kinds = new Set(node.evidence.map((item) => item.kind));
    for (const requirement of node.evidence_requirements) {
      if (!kinds.has(requirement)) {
        result.errors.push({
          code: 'evidence.missing-requirement',
          node_id: node.node_id,
          message: `${node.node_id} lacks required evidence kind ${requirement}`,
        });
      }
    }
  }
  if (
    node.status !== 'validated' &&
    node.release_requirement === 'required' &&
    !TERMINAL_STATUSES.has(node.status)
  ) {
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
}

function validateStackedWork(
  node: EpicNode,
  nodesById: ReadonlyMap<string, EpicNode>,
  now: Date,
  result: MutableValidation,
): void {
  const sw = node.stacked_work;
  if (!sw) return;

  // stacked_work is only allowed while lifecycle status is 'blocked'
  if (node.status !== 'blocked') {
    result.errors.push({
      code: 'stacked.non-blocked-status',
      node_id: node.node_id,
      message: `${node.node_id} has stacked_work but lifecycle status is ${node.status}; stacked_work is only valid when status is blocked`,
    });
  }

  // stacked_work requires a materialized child issue for provenance
  if (!node.github.issue) {
    result.errors.push({
      code: 'stacked.missing-issue',
      node_id: node.node_id,
      message: `${node.node_id} stacked_work requires a materialized child issue (node.github.issue)`,
    });
  }

  // stacked_pr_open status requires a dependent PR number
  if (sw.status === 'stacked_pr_open' && sw.dependent.pr_number === null) {
    result.errors.push({
      code: 'stacked.pr-open-missing-number',
      node_id: node.node_id,
      message: `${node.node_id} stacked_work.status is stacked_pr_open but dependent.pr_number is null`,
    });
  }

  // Stale resync check: resync must be within the 48-hour window
  if (now.getTime() - Date.parse(sw.resync.at) > STACKED_STALE_RESYNC_MS) {
    result.errors.push({
      code: 'stacked.stale-resync',
      node_id: node.node_id,
      message: `${node.node_id} stacked_work resync at ${sw.resync.at} is stale (exceeds 48h); rebase the stacked branch and update resync`,
    });
  }

  // Invalid lane: verification lane cannot have stacked work
  if (STACKED_FORBIDDEN_LANES.has(node.execution_lane)) {
    result.errors.push({
      code: 'stacked.invalid-lane',
      node_id: node.node_id,
      message: `${node.node_id} execution_lane '${node.execution_lane}' does not support stacked_work; speculative work requires a non-verification lane`,
    });
  }

  // dependency.node_id must be one of the node's listed dependencies
  if (!node.dependencies.includes(sw.dependency.node_id)) {
    result.errors.push({
      code: 'stacked.dependency-node-mismatch',
      node_id: node.node_id,
      message: `${node.node_id} stacked_work.dependency.node_id (${sw.dependency.node_id}) is not in the node's dependency list`,
    });
  } else {
    // Cross-validate PR number against the dependency node's tracked PR, if present
    const depNode = nodesById.get(sw.dependency.node_id);
    if (depNode?.github.pr && depNode.github.pr.number !== sw.dependency.pr_number) {
      result.errors.push({
        code: 'stacked.dependency-pr-snapshot-mismatch',
        node_id: node.node_id,
        message:
          `${node.node_id} stacked_work.dependency.pr_number (${sw.dependency.pr_number}) does not match ` +
          `${sw.dependency.node_id}'s tracked PR #${depNode.github.pr.number}`,
      });
    }
  }

  // Premature rebase-to-main completion: complete only when all dependencies are in
  // merged or validated status (or superseded→validated). Matching the recovery doc:
  // rebase-to-main is performed the moment the dependency PR lands, so 'merged' is
  // a valid gate — full 'validated' status is not required.
  if (sw.rebase_to_main.state === 'complete') {
    const allDepsLanded = node.dependencies.every((depId) => {
      const dep = nodesById.get(depId);
      if (!dep) return false;
      if (POST_MERGE_STATUSES.has(dep.status)) return true;
      // Superseded node: check its replacement
      if (dep.status === 'superseded' && dep.superseded_by) {
        const replacement = nodesById.get(dep.superseded_by);
        return replacement ? POST_MERGE_STATUSES.has(replacement.status) : false;
      }
      return false;
    });
    if (!allDepsLanded) {
      result.errors.push({
        code: 'stacked.premature-rebase-complete',
        node_id: node.node_id,
        message: `${node.node_id} stacked_work marks rebase_to_main as complete but not all dependencies are merged or validated`,
      });
    }
    // completed_at must be populated when state is complete
    if (sw.rebase_to_main.completed_at === null) {
      result.errors.push({
        code: 'stacked.rebase-complete-missing-timestamp',
        node_id: node.node_id,
        message: `${node.node_id} stacked_work rebase_to_main.state is 'complete' but completed_at is null`,
      });
    }
  }
}

function validateDuplicateStackedOwnership(state: EpicState, result: MutableValidation): void {
  const stackedWorkByOwner = new Map<string, string>();
  for (const node of state.nodes) {
    const sw = node.stacked_work;
    if (!sw) continue;
    const key = `${sw.owner.claimant}\u0000${sw.owner.session}`;
    const prior = stackedWorkByOwner.get(key);
    if (prior) {
      result.errors.push({
        code: 'stacked.duplicate-ownership',
        node_id: node.node_id,
        message: `${sw.owner.claimant}/${sw.owner.session} has stacked_work on both ${prior} and ${node.node_id}; a session may only hold one stacked-work slot`,
      });
    } else {
      stackedWorkByOwner.set(key, node.node_id);
    }
  }
}

function validateDuplicateOwnership(state: EpicState, result: MutableValidation): void {
  const ownership = new Map<string, string>();
  const issues = new Map<number, string>();
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

  const contractValid = !result.errors.some(
    (e) => e.code === 'plan.contract-drift' || e.code === 'plan.contract-invalid',
  );

  const nodesById = new Map(state.nodes.map((node) => [node.node_id, node]));
  validateDag(state, nodesById, result);
  const now = options.now ?? new Date();
  const gitReader = options.gitReader ?? createDefaultGitReader(options.repoRoot);
  for (const node of state.nodes) {
    validateNodeLifecycle(state, node, nodesById, now, options.repoRoot, gitReader, result);
    validateStackedWork(node, nodesById, now, result);
  }
  validateDuplicateOwnership(state, result);
  validateDuplicateStackedOwnership(state, result);

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

function makeClaimKey(nodeId: string, claimant: string, session: string): string {
  // Use NUL as the compound-key separator because these structured text fields
  // cannot contain U+0000, so the joined key remains unambiguous.
  return `${nodeId}\u0000${claimant}\u0000${session}`;
}

function makeOwnerSessionKey(claimant: string, session: string): string {
  return `${claimant}\u0000${session}`;
}

function parseTrustedStructuredFields(
  comment: GithubComment,
  heading: 'CLAIMED' | 'BLOCKED',
): Map<string, string> | null {
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association)) {
    return null;
  }
  const lines = comment.body.split(/\r?\n/);
  if (lines[0]?.trim() !== heading) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) fields.set(match[1], match[2]);
  }
  return fields;
}

function parseTrustedClaim(comment: GithubComment, expectedNodeId?: string): ParsedClaim | null {
  const fields = parseTrustedStructuredFields(comment, 'CLAIMED');
  if (!fields) return null;
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

function parseTrustedBlockedNode(comment: GithubComment, expectedNodeId?: string): string | null {
  const fields = parseTrustedStructuredFields(comment, 'BLOCKED');
  if (!fields) return null;
  const nodeId = fields.get('node') ?? expectedNodeId;
  if (!nodeId) return null;
  if (expectedNodeId !== undefined && nodeId !== expectedNodeId) return null;
  return nodeId;
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
      const expectedNodeId = expectedNode?.node_id ?? state.claim_policy.bootstrap_node;
      const liveClaims = new Map<string, ParsedClaim>();
      for (const comment of comments) {
        const blockedNodeId = parseTrustedBlockedNode(comment, expectedNodeId);
        if (blockedNodeId) {
          const claimKeysToDelete = [...liveClaims.entries()]
            .filter(([, claim]) => claim.nodeId === blockedNodeId)
            .map(([claimKey]) => claimKey);
          for (const claimKey of claimKeysToDelete) {
            liveClaims.delete(claimKey);
          }
          continue;
        }
        const claim = parseTrustedClaim(comment, expectedNodeId);
        if (!claim || Date.parse(claim.expiresAt) <= now.getTime()) continue;
        liveClaims.set(makeClaimKey(claim.nodeId, claim.claimant, claim.session), claim);
      }
      issueClaims.push(...liveClaims.values());
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

  // Audit stacked_work: reconcile dependency and dependent PR heads/state for blocked nodes
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
    if (!sw) continue;
    const nodeIdx = state.nodes.indexOf(node);

    // Audit the dependency PR
    const [depOwner, depRepo] = sw.dependency.repository.split('/');
    if (depOwner && depRepo) {
      try {
        const depPull = prSchema.parse(
          runner.get(`/repos/${depOwner}/${depRepo}/pulls/${sw.dependency.pr_number}`),
        ) as GithubPull;
        // Propose update if dependency head drifted from our snapshot
        if (depPull.head.sha !== sw.dependency.head_sha) {
          repoPatch.push({
            op: 'replace',
            path: `/nodes/${nodeIdx}/stacked_work/dependency/head_sha`,
            value: depPull.head.sha,
            reason: `Dependency PR #${sw.dependency.pr_number} head advanced on GitHub; stacked branch may need rebase`,
          });
          operatorActions.push(
            `${node.node_id} stacked_work dependency PR #${sw.dependency.pr_number} head advanced ` +
              `from ${sw.dependency.head_sha} to ${depPull.head.sha}. ` +
              `Rebase the stacked branch and update stacked_work.resync.`,
          );
        }
        // Warn if the dependency PR has already merged (should trigger normal handoff)
        if (depPull.merged) {
          operatorActions.push(
            `${node.node_id} stacked_work dependency PR #${sw.dependency.pr_number} is merged on GitHub ` +
              `(merge_commit: ${depPull.merge_commit_sha ?? 'unknown'}). ` +
              `Producer must complete rebase-to-main and transition ${node.node_id} through the normal lifecycle.`,
          );
        }
      } catch (error) {
        errors.push({
          code: 'stacked.dependency-pr-audit',
          node_id: node.node_id,
          message: `Could not audit stacked dependency PR #${sw.dependency.pr_number}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    // Audit the dependent (speculative) PR, if present
    if (sw.status === 'stacked_pr_open' && sw.dependent.pr_number !== null) {
      try {
        const depPull = prSchema.parse(
          runner.get(`/repos/${owner}/${repo}/pulls/${sw.dependent.pr_number}`),
        ) as GithubPull;
        // Propose update if dependent head drifted
        if (depPull.head.sha !== sw.dependent.head_sha) {
          repoPatch.push({
            op: 'replace',
            path: `/nodes/${nodeIdx}/stacked_work/dependent/head_sha`,
            value: depPull.head.sha,
            reason: `Dependent stacked PR #${sw.dependent.pr_number} head advanced on GitHub`,
          });
        }
        // Error if stacked PR is already merged or closed without a lifecycle transition
        if (depPull.merged) {
          errors.push({
            code: 'stacked.dependent-pr-merged',
            node_id: node.node_id,
            message:
              `${node.node_id} stacked PR #${sw.dependent.pr_number} is merged on GitHub but node lifecycle is still blocked. ` +
              `Producer must verify and execute the stacked-work recovery handoff protocol.`,
          });
          operatorActions.push(
            `${node.node_id} stacked PR #${sw.dependent.pr_number} merged unexpectedly ` +
              `(merge_commit: ${depPull.merge_commit_sha ?? 'unknown'}). ` +
              `Execute STACKED-WORK-RECOVERY.md handoff immediately.`,
          );
        } else if (!depPull.merged && depPull.state === 'closed') {
          errors.push({
            code: 'stacked.dependent-pr-closed',
            node_id: node.node_id,
            message:
              `${node.node_id} stacked PR #${sw.dependent.pr_number} is closed without merging. ` +
              `Producer must investigate and clear stacked_work or reopen the speculative PR.`,
          });
          operatorActions.push(
            `${node.node_id} stacked PR #${sw.dependent.pr_number} was closed without merging. ` +
              `Determine whether to reopen, abandon, or escalate the speculative work.`,
          );
        }
      } catch (error) {
        errors.push({
          code: 'stacked.dependent-pr-audit',
          node_id: node.node_id,
          message: `Could not audit stacked dependent PR #${sw.dependent.pr_number}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  }

  const claimsByNode = new Map<string, ParsedClaim[]>();
  const claimsByOwner = new Map<string, ParsedClaim[]>();
  for (const claim of issueClaims) {
    const byNode = claimsByNode.get(claim.nodeId) ?? [];
    byNode.push(claim);
    claimsByNode.set(claim.nodeId, byNode);
    const ownerKey = makeOwnerSessionKey(claim.claimant, claim.session);
    const byOwner = claimsByOwner.get(ownerKey) ?? [];
    byOwner.push(claim);
    claimsByOwner.set(ownerKey, byOwner);
  }
  // Deduplicate: for same node+claimant+session, keep only the newest claim (heartbeat
  // replacement pattern posts a new CLAIMED comment before the old one expires).
  const deduplicatedClaims: ParsedClaim[] = [];
  for (const [, claimsForNode] of claimsByNode) {
    const uniqueSessions = new Map<string, ParsedClaim>();
    for (const claim of claimsForNode) {
      const sessionKey = makeOwnerSessionKey(claim.claimant, claim.session);
      const prior = uniqueSessions.get(sessionKey);
      if (!prior || Date.parse(claim.claimedAt) > Date.parse(prior.claimedAt)) {
        uniqueSessions.set(sessionKey, claim);
      }
    }
    deduplicatedClaims.push(...uniqueSessions.values());
  }
  // Rebuild per-node and per-owner maps from deduplicated claims.
  const deduplicatedByNode = new Map<string, ParsedClaim[]>();
  const deduplicatedByOwner = new Map<string, ParsedClaim[]>();
  for (const claim of deduplicatedClaims) {
    const byNode = deduplicatedByNode.get(claim.nodeId) ?? [];
    byNode.push(claim);
    deduplicatedByNode.set(claim.nodeId, byNode);
    const sessionKey = makeOwnerSessionKey(claim.claimant, claim.session);
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
        if (liveClaim.claimant !== owns.claimant || liveClaim.session !== owns.session) {
          operatorActions.push(
            `Live claim on ${nodeId} (claimant: ${liveClaim.claimant}, session: ${liveClaim.session}) ` +
              `differs from cached ownership (claimant: ${owns.claimant ?? 'none'}, session: ${owns.session ?? 'none'}). ` +
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
