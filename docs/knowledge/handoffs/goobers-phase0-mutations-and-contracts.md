# Phase 0: CI/Goobers Lifecycle Mutation Inventory and Contracts

**Issue**: #3840  
**Status**: Foundation - blocks shadow-mode start until complete  
**Scope**: Six workflows (`ci-recovery-router`, `ci-recovery`, `merge-train`, `merge-train-validate`, `goobers-run`, `goobers-validate`) plus transitive mutation scripts.

## Mutation Path Inventory

Complete mapping of every state-mutating edge in CI/Goobers orchestration, with exact file+line references.

### 1. CI Recovery Router Workflow (`.github/workflows/ci-recovery-router.yml`)

**Purpose**: Read-only event router that gates CI Recovery dispatch based on capacity budget.

| Mutation Edge              | File                                       | Lines     | Action                                              | State Target                   | Payload Schema                                                                                                    |
| -------------------------- | ------------------------------------------ | --------- | --------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Dispatch workflow_dispatch | `.github/workflows/ci-recovery-router.yml` | 97        | `node .github/scripts/ci-recovery/router.mjs`       | Dispatches `ci-recovery.yml`   | GHA inputs to workflow_dispatch                                                                                   |
| Lease-reaper dispatch      | `.github/scripts/ci-recovery/router.mjs`   | 1754–1756 | POST `actions/workflows/ci-recovery.yml/dispatches` | CI Recovery lease-reaper queue | `{ operation: 'reconcile', pr_number, trigger: 'lease-reaper' \| 'liveness-sweep:closed-owner-fence', lease_id }` |
| Normal dispatch loop       | `.github/scripts/ci-recovery/router.mjs`   | 1875–1877 | POST `actions/workflows/ci-recovery.yml/dispatches` | CI Recovery PR recovery queue  | `{ operation: 'reconcile', pr_number, trigger, expected_head_sha?, expected_base_ref?, lease_id }`                |

**Invariants**:

- Single unconditional concurrency group (`crawler-ci-recovery-router`) ensures no two router runs execute simultaneously
- Dispatch budget is applied uniformly across all event types
- Router invocation is idempotent: re-running with same input produces same output
- No PR mutations (no labels, comments, or check-run creation beyond its own job status)

---

### 2. CI Recovery Workflow (`.github/workflows/ci-recovery.yml`)

**Purpose**: Per-PR mutation orchestrator. Reconciles CI failures, updates PR state, manages shepherd leases.

| Mutation Edge           | File                                        | Lines                                 | Action                                                                                                          | State Target                                                    | Payload Schema                                                                                          |
| ----------------------- | ------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Fetch token             | `.github/workflows/ci-recovery.yml`         | 76–91                                 | GitHub App token                                                                                                | Read-only bucket                                                | `{ token: string }`                                                                                     |
| Run reconciliation      | `.github/workflows/ci-recovery.yml`         | 99                                    | `node .github/scripts/ci-recovery/reconcile.mjs`                                                                | PR labels, comments, workflow dispatches                        | See reconcile.mjs contract                                                                              |
| Thread resolution       | `.github/scripts/ci-recovery/reconcile.mjs` | 1837, 2286, 2432                      | `POST /repos/.../pulls/.../comments/.../replies`                                                                | Review thread state                                             | `{ body: string }` (with `✅ Addressed` markers)                                                        |
| PR comment (state)      | `.github/scripts/ci-recovery/reconcile.mjs` | 678–684                               | `PATCH/POST /repos/.../issues/.../comments`                                                                     | Authoritative state comment                                     | See state-comment schema below                                                                          |
| Label add/remove        | `.github/scripts/ci-recovery/reconcile.mjs` | 718–720, 755, 782–784                 | `POST/DELETE /repos/.../issues/.../labels`                                                                      | PR labels                                                       | `{ labels: string[] }`                                                                                  |
| Lifecycle comment write | `.github/scripts/ci-recovery/reconcile.mjs` | 816–832                               | `PATCH /repos/.../issues/comments/{id}` (single existing) or `POST /repos/.../issues/{n}/comments` (none exist) | PR lifecycle-phase comment                                      | `{ body: string }`                                                                                      |
| Repository-label fence  | `.github/scripts/ci-recovery/reconcile.mjs` | 909–958                               | `DELETE /repos/.../labels/{name}` and GraphQL `deleteLabel` mutation on `nodeId`                                | Repository-scoped mutual-exclusion fence label (not a PR label) | `{ }` (DELETE); `mutation($labelId: ID!) { deleteLabel(input: { id: $labelId }) { clientMutationId } }` |
| Workflow dispatch       | `.github/scripts/ci-recovery/reconcile.mjs` | 1150, 2098–2104, 2840–2846, 3678–3684 | CI Recovery/auto-rebase/router `workflow_dispatch`                                                              | Lease and recovery follow-ups                                   | `{ operation, pr_number, trigger, lease_id, expected_head_sha?, expected_base_ref? }`                   |

**Invariants**:

- Single owner per PR (`lease_id` field) prevents concurrent mutation of the same PR
- Lease operations (`acquire`, `heartbeat`, `release`) are sequentially idempotent
- Fail-closed on `expected_head_sha`/`expected_base_ref` mismatch: skips all mutations if live PR no longer matches the invoker's snapshot
- State comment is the single authoritative source of truth for PR disposition (CI results, next action, lock holder)
- Thread resolution only marks comments with `✅ Addressed` or `✅ Not applicable` — never changes comment count

---

### 3. Merge Train Workflow (`.github/workflows/merge-train.yml`)

**Purpose**: Manages PR queue, candidacy validation, and promotion to main.

| Mutation Edge                              | File                                                                                         | Lines            | Action                                                                          | State Target                                                                          | Payload Schema                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Train gate action                          | `.github/actions/train-gate/action.yml`                                                      | 27–43            | Check MERGE_TRAIN_ENABLED                                                       | Job gating                                                                            | `{ enabled: 'true' \| 'false' }`                                                                      |
| Generate app token                         | `.github/workflows/merge-train.yml`                                                          | 81–84            | GitHub App token                                                                | Write-scoped bucket                                                                   | `{ token: string }`                                                                                   |
| Run reconcile                              | `.github/workflows/merge-train.yml`                                                          | 110              | `node .github/scripts/merge-train/reconcile.mjs`                                | PR labels, queue state, PR/candidate commits                                          | See reconcile.mjs contract                                                                            |
| Quarantine repair                          | `.github/workflows/merge-train.yml`                                                          | 119              | `node .github/scripts/merge-train/quarantine-repair.mjs`                        | PR labels (quarantine repair only)                                                    | `{ labels: string[] }`                                                                                |
| Label mutations                            | `.github/scripts/merge-train/reconcile.mjs`                                                  | 194–196, 204     | `POST/DELETE /repos/.../issues/.../labels`                                      | `merge-train`, `merge-train-landed`, etc.                                             | `{ labels: string[] }`                                                                                |
| Check-run creation                         | `.github/scripts/merge-train/reconcile.mjs`                                                  | 535–546          | `POST /repos/.../check-runs`                                                    | Validation gate on main                                                               | `{ name, head_sha, status, conclusion, output }`                                                      |
| Workflow dispatch                          | `.github/scripts/merge-train/reconcile-lib.mjs`                                              | 459–482          | Candidate validation dispatch                                                   | Merge Train Validation job queue                                                      | See candidate schema below                                                                            |
| PR update (merge)                          | `.github/scripts/merge-train/reconcile-lib.mjs`                                              | 1447–1456        | `PUT /repos/.../pulls/.../merge`                                                | Promote to main                                                                       | `{ merge_method: 'squash', commit_title, commit_message }`                                            |
| Branch update                              | `.github/scripts/merge-train/reconcile.mjs`, `.github/scripts/merge-train/reconcile-lib.mjs` | 976–982; 498–529 | `PUT /pulls/.../update-branch` and candidate transport ref push/delete          | PR head rebinding + candidate ref lifecycle                                           | `{ expected_head_sha }`, Git ref/blob transport                                                       |
| Empty-train incident create/update/close   | `.github/scripts/merge-train/reconcile.mjs`                                                  | 243–284          | `POST /repos/.../issues` (create), `PATCH /repos/.../issues/{n}` (update/close) | Empty-train incident issue                                                            | `{ title, labels, body }` (create); `{ body }` or `{ state: 'closed', body }` (update/close)          |
| Stalled-train incident create/update/close | `.github/scripts/merge-train/reconcile.mjs`                                                  | 361–408          | `POST /repos/.../issues` (create), `PATCH /repos/.../issues/{n}` (update/close) | Stalled-train incident issue (carries the consecutive-stall-pass counter in its body) | `{ title, labels, body }` (create); `{ body, labels? }` or `{ state: 'closed', body }` (update/close) |

**Invariants**:

- Single concurrency slot (`queue: single`) ensures one merge-train cycle at a time
- FIFO ordering: admitted PRs advance in label-receipt order; `merge-train` label is the queue membership token
- Candidate validation is dispatched with immutable `candidate_sha` + `candidate_ref` + `fingerprint` (generation token)
- Promotion updates `expected_head/base` and atomically merges only if they still match live PR state
- No auto-merge arming: the workflow itself calls `disableAutoMerge()` to prevent false-confidence queueing
- Quarantine repair runs after reconcile to catch fresh third-strike quarantines in the same cycle

---

### 4. Merge Train Validation Workflow (`.github/workflows/merge-train-validate.yml`)

**Purpose**: Immutable, trusted validation of a candidate commit before promotion.

| Mutation Edge         | File                                                   | Lines                | Action                                         | State Target                         | Payload Schema                                            |
| --------------------- | ------------------------------------------------------ | -------------------- | ---------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| Materialize candidate | `.github/scripts/merge-train/materialize-candidate.sh` | 18, 39–47            | Fetch + checkout immutable candidate           | Local candidate tree                 | Git blob materialization                                  |
| Check-run creation    | `.github/workflows/merge-train-validate.yml`           | 269–309, 523–560     | `POST/PATCH /repos/.../commits/.../check-runs` | Validation gate on `attestation_sha` | `{ name, head_sha: attestation_sha, status, conclusion }` |
| Report timing         | `.github/workflows/merge-train-validate.yml`           | 71–76, 119–124, etc. | `echo "### ..." >> $GITHUB_STEP_SUMMARY`       | Job summary                          | Markdown (informational only)                             |

**Invariants**:

- Candidate ref is opaque and immutable for the lifetime of the validation run
- Validation gates (`typecheck:src`, `lint`, unit tests, sprite tests, headless) all run against the same immutable candidate
- Check-runs report to `attestation_sha` (main), not `candidate_sha`, so validation gates remain on main's timeline
- All validation jobs use `fail-fast: false` to collect all failures in one pass
- No mutations to candidate branch or PR state; validation is read-only on inputs

---

### 5. Goobers Run Workflow (`.github/workflows/goobers-run.yml`)

**Purpose**: Orchestrates Goobers feature-PR workflow (LLM agent planning + implementation + review).

| Mutation Edge       | File                                | Lines             | Action                                | State Target                         | Payload Schema                                                                                                                                                        |
| ------------------- | ----------------------------------- | ----------------- | ------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserve source     | `.github/workflows/goobers-run.yml` | 81–84             | `cp -R .goobers`                      | Runner temp                          | Filesystem copy (trusted source)                                                                                                                                      |
| Recovery resolution | `.github/workflows/goobers-run.yml` | 86–137            | `node` recovery script (inline shell) | Environment variable                 | `GOOBERS_RECOVERY_ISSUE` (GitHub issue number)                                                                                                                        |
| Run Goobers         | `.github/workflows/goobers-run.yml` | 358               | `goobers run`                         | Goobers instance, PR creation/update | CLI args (`--github-progress "$GOOBERS_WORKFLOW" "$GOOBERS_INSTANCE"`), not a `crawler.goobers.invocation/v1` envelope — see note under the Invocation Contract below |
| Issue mutation      | Goobers workflow output             | (via goobers SDK) | Add labels, post comments             | Issue state                          | `{ labels, status, pr_number }`                                                                                                                                       |
| PR creation/update  | Goobers workflow output             | (via goobers SDK) | `gh pr create` or update              | Feature PR                           | Standard GH PR payload                                                                                                                                                |

**Invariants**:

- `.goobers/` source is copied to temp before any invocation to ensure trusted configuration
- Recovery resolution is idempotent: repeated calls with same issue/PR state produce same GOOBERS_RECOVERY_ISSUE value
- Goobers runs serially (`concurrency: { cancel-in-progress: false }`) to avoid concurrent feature-PR creation
- Issue number resolution prefers open `goobers/status:in-review` issues with open Goobers branch PRs
- `abandon_existing` flag requires explicit issue_number (not auto-selected) to prevent accidental PR closure

---

### 6. Goobers Validate Workflow (`.github/workflows/goobers-validate.yml`)

**Purpose**: Offline validation of `.goobers/` workflow sources against Goobers binary.

| Mutation Edge      | File                                     | Lines | Action                                    | State Target         | Payload Schema                |
| ------------------ | ---------------------------------------- | ----- | ----------------------------------------- | -------------------- | ----------------------------- |
| Resolve checksum   | `.github/workflows/goobers-validate.yml` | 25–40 | `case ${GOOBERS_VERSION}`                 | Environment variable | `GOOBERS_SHA256` (hex digest) |
| Validate workflows | `.github/workflows/goobers-validate.yml` | 85    | `goobers validate --source-tree .goobers` | Validation exit code | `{ status: 0 \| non-zero }`   |

**Invariants**:

- No state mutations: validation only checks schema/lint and exits with code
- Checksum is hard-coded per version; version upgrade requires diff review of new digest
- Validation fails closed (non-zero exit) on unknown version or schema violation

---

## Contract Schemas (v1)

### GHA → Goobers Invocation Contract

**Schema**: `crawler.goobers.invocation/v1`

Payload structure for the internal dispatch envelope CI Recovery Router and
Merge Train use when they trigger CI Recovery / Merge Train Validate via
`workflow_dispatch`. **This does not cover Goobers Run**
(`.github/workflows/goobers-run.yml`): that workflow's own `workflow_dispatch`
inputs (`goobers_version`, `workflow`, `issue_number`, `abandon_existing`) are
never packaged into a `crawler.goobers.invocation/v1` envelope anywhere in the
codebase — `goobers run` is invoked as a CLI entry point, not a JSON-envelope
dispatch. Those inputs are validated directly against the workflow YAML via
`REQUIRED_DISPATCH_INPUTS['goobers-run.yml']` in
`validate-goobers-contracts.mjs` instead, as a separate, simpler contract.

```json
{
  "contractVersion": "v1",
  "workflowName": "string (required)",
  "operation": "string (required: 'reconcile', 'lease-acquire', 'lease-heartbeat', 'lease-release', 'validate-candidate')",
  "pr_number": "string, numeric (e.g. '42') — GitHub Actions workflow_dispatch inputs are always strings, never number/null; required for PR-scoped operations, forbidden for batch operations",
  "expected_head_sha": "string | empty",
  "expected_base_ref": "string | empty",
  "fingerprint": "string (for candidate validation) | empty",
  "candidate_sha": "string (for candidate validation) | empty",
  "candidate_ref": "string (for candidate validation) | empty",
  "attestation_sha": "string (for candidate validation) | empty",
  "pr_numbers": "string (comma-separated for batch operations) | empty",
  "lease_id": "string (non-secret shepherd id) | empty",
  "trigger": "string, free-form business-reason (e.g. 'merge-train-noop', 'merge-train-cumulative-conflict:41', '${eventName}:sweep'); NOT a closed GitHub-event enum — real dispatch call sites in reconcile.mjs/router.mjs mint dynamic reason strings that a fixed enum would reject",
  "issue_number": "string, numeric (e.g. '3840') — same string-only constraint as pr_number"
}
```

**Validation Rules**:

- `contractVersion` must be `"v1"`; unknown versions → fail closed
- `operation` must be one of the allowed enum values; unknown operations → error
- When `operation` contains "candidate": `candidate_sha`, `candidate_ref`, `attestation_sha`, `fingerprint` all required
- When `expected_head_sha` is set: `expected_base_ref` is required
- `pr_number` required for all PR-scoped operations (reconcile, lease-\*); forbidden for others
- `pr_number`/`issue_number` must match `^[0-9]+$` when present (fail closed on non-numeric-string values, e.g. a raw JSON number)
- Field names and types must match exactly (no extra fields ignored, no missing required fields)

---

### Goobers → State Output Contract

**Schema**: `crawler.goobers.output/v1`

Payload structure produced by Goobers workflows and written to PR/issue state comments:

```json
{
  "contractVersion": "v1",
  "task": "string, required (enum: 'query-backlog', 'hydrate-requirements', 'plan', 'materialize-plan', 'implement', 'push-branch', 'local-ci', 'open-pr', 'close-out', 'park-needs-human', 'needs-remediation', 'review', 'local-gate', 'pr-opened-gate' — see .goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml)",
  "status": "string (enum: 'success', 'failure', 'no-work', 'blocked')",
  "outputs": {
    "verdict": "string | null (enum: 'recommended', 'risky', 'not-recommended'); only non-null when task='plan'",
    "appleEstimate": "number | null (1–5); only non-null when task='plan'",
    "hardGate": "string | null (gate criteria); only non-null when task is one of 'plan', 'local-gate', 'pr-opened-gate', 'review'",
    "blockedBy": "string | null (comma-separated issue numbers)",
    "disposition": "string | null (enum: 'completed-existing-work'); only non-null when status='no-work'"
  },
  "summary": "string (one-line summary for human)",
  "error": {
    "code": "string (enum: 'REQUIREMENTS_MISMATCH', 'TEST_FAILURE', 'MERGE_CONFLICT', etc.)",
    "message": "string (actionable error description)"
  } | null
}
```

**Validation Rules**:

- `contractVersion` must be `"v1"`; unknown versions → fail closed
- `task` is a required discriminator; it names the producing Goobers task/gate and gates which `outputs` fields are applicable
- `status` must be one of the allowed enum values
- When `status` is `'failure'` or `'blocked'`: `error` object is required and both `code` and `message` must be non-empty
- When `status` is `'success'` or `'no-work'`: `error` must be omitted or null
- `outputs` is always present as an object; scalar fields may be null but key must exist
- `outputs.verdict` only present/non-null when `task='plan'`; forbidden for every other task
- `outputs.appleEstimate` only present/non-null when `task='plan'`; value must be 1–5
- `outputs.hardGate` only present/non-null when `task` is one of `'plan'`, `'local-gate'`, `'pr-opened-gate'`, `'review'`; forbidden for every other task
- `outputs.disposition` may be `'completed-existing-work'` only when `status='no-work'`; Goobers Run uses it to retire already-satisfied approved issues from scheduled selection
- `summary` must be non-empty string for all states
- Deterministic gates fail on schema violation (unknown status, missing required error, invalid enum value, task-gated field misuse)

---

### PR State Comment Schema

**Schema**: `crawler.pr-state/v1`

Authoritative PR state tracked in a pinned comment (created/updated by CI Recovery). The
canonical format is defined by `.github/scripts/ci-recovery/markers.mjs`
(`STATE_MARKER`, `STATE_DATA_PREFIX`) and rendered by `renderStateComment()` /
parsed by `parseStateComment()` in `.github/scripts/ci-recovery/state.mjs` — it is a
marker line, a base64url-encoded JSON data line, and Markdown bullet fields, **not**
a Markdown table:

```markdown
<!-- crawler-ci-state:v1 -->
<!-- crawler-ci-state-data:<base64url-encoded JSON state> -->

## Crawler CI recovery state

- Owner: `<shepherd-id | none>`
- Status: `<waiting | recovering | blocked | landed | ...>`
- Head: `<head-sha>`
- Fingerprint: `<candidate/blocker fingerprint>`
- Blockers: none | `<kind>:<id>, <kind>:<id>, ...`
- Automation attempt: <n> (only present when `progressAt` is set)
- Progress observed: <ISO 8601 timestamp> (only present when `progressAt` is set)
- Recovery disposition: `stale-automation-exhausted` (only present for that trigger)
- Retry count: <n> (only present for that trigger)
- Next action: <free text> (only present for that trigger)
- Updated: <ISO 8601 timestamp>

_This comment is managed by the trusted CI recovery workflow._
```

**Invariants**:

- Single comment per PR; created once and updated in place (never deleted)
- `STATE_MARKER` (`<!-- crawler-ci-state:v1 -->`) enables deterministic lookup; the base64url data line is the machine-readable source of truth, the bullets are a human-readable projection of the same state
- The data line round-trips exactly through `renderStateComment()`/`parseStateComment()`; `validateState()` enforces the required fields before encoding
- Lease/attempt/progress bullets are conditionally rendered based on `state.progressAt` and `state.trigger`, not always present
- Thread resolution (`✅ Addressed`/`✅ Not applicable` markers) is a separate mechanism (PR review-comment replies), not part of this state comment

---

## Deterministic Invariant Checks

Executable checks enforced by existing test suites (no new test files; integrate into existing harnesses):

### 1. Single-Owner Fence Coherence

**Location**: `tests/unit/goobers-run-workflow.test.ts` (or integration test)
**Check**: For each PR in flight, there is at most one holder of the `lease_id` field in the state comment
**Fail Condition**: Multiple leases on same PR, or lease mismatch between comment and CI Recovery input
**Recovery**: CI Recovery fails closed and escalates to human review

### 2. Single Authoritative State Comment

**Location**: `.github/scripts/ci-recovery/reconcile.test.mjs` (Node test)
**Check**: For each PR, there is exactly one comment matching `STATE_MARKER` (`<!-- crawler-ci-state:v1 -->`)
**Fail Condition**: Zero or >1 matching comments found
**Recovery**: Reconciliation repairs by deleting duplicates and recreating the authoritative copy

### 3. Expected Head/Base Fail-Closed Mutation Fencing

**Location**: `.github/scripts/ci-recovery/reconcile.test.mjs`
**Check**: When `expected_head_sha` + `expected_base_ref` are set, reconciliation skips all mutations if live PR state differs
**Fail Condition**: Mutations occur despite head/base mismatch
**Recovery**: Guard in reconcile.mjs prevents mutation; test fixture proves the guard works

### 4. No In-Process Retry of Non-Idempotent Operations

**Location**: `.github/scripts/ci-recovery/router.test.mjs`
**Check**: Router does not retry `workflow_dispatch` on transient failure; each dispatch is independent
**Fail Condition**: Multiple identical dispatches issued from single router run
**Recovery**: Router exits on dispatch failure; human re-triggers via manual dispatch

### 5. Retry-Safe Candidate Publication Semantics

**Location**: `.github/scripts/merge-train/reconcile.test.mjs`
**Check**: Candidate validation dispatch includes idempotency key (fingerprint); re-dispatch with same key is no-op
**Fail Condition**: Two validation runs created for same fingerprint
**Recovery**: Merge Train Validation completes first, reconciliation observes result and skips promotion if stale

### 6. Workspacebranch Recovery Rebinding

**Location**: `.github/scripts/merge-train/reconcile.test.mjs`
**Check**: PR branch update is only applied when `behind` state is detected and rebind succeeds atomically
**Fail Condition**: PR branch update succeeds but reconciliation re-derives queue state before seeing result
**Recovery**: FIFO line is held for updated PR; next cycle admits the now-current PR

---

## Single-Writer Lock/Lease Design

### State Machine

```
┌─────────────────────────────────────────────────────────────────┐
│                    PR Lifecycle States                           │
└─────────────────────────────────────────────────────────────────┘

  (New PR)
    │
    ├─ CI Recovery Router observes event
    │  └─ Increments dispatch budget counter
    │
    ├─ CI Recovery dispatched
    │  └─ Calls reconcile.mjs (operation: 'reconcile')
    │
    ├─ Lease not held
    │  └─ Acquire lease_id = <actor>:<workflow>:<pr>:<sha>:<fingerprint>:<timestamp>
    │
    ├─ [Reconciliation Loop]
    │  ├─ Read PR metadata (checks, labels, state comment)
    │  ├─ Derive disposition (admitted, blocked, stalled, etc.)
    │  ├─ Emit state comment update
    │  ├─ Dispatch subsequent workflows if needed (MTV, merge, etc.)
    │  └─ Heartbeat lease (renew expiry)
    │
    ├─ [Promotion Path (Merge Train)]
    │  ├─ PR admitted to queue (merge-train label)
    │  ├─ Candidate validation requested
    │  ├─ Candidate passes → dispatch merge
    │  └─ Merge succeeds → Release lease_id, add merge-train-landed label
    │
    └─ (PR closed or landed)
       └─ Release lease
```

### Idempotency Key Shape

```
<actor-domain>:<workflow-run-id>:<pr-number>:<head-sha>:<fingerprint>:<sequence>
```

| Component         | Source                                                                       | Purpose                 | Example                 |
| ----------------- | ---------------------------------------------------------------------------- | ----------------------- | ----------------------- |
| `actor-domain`    | Caller identity (GHA action name or `manual`)                                | Actor segregation       | `ci-recovery-router`    |
| `workflow-run-id` | `github.run_id` of caller                                                    | Workflow run uniqueness | `9876543210`            |
| `pr-number`       | PR number                                                                    | PR segregation          | `1234`                  |
| `head-sha`        | PR head SHA at invocation time                                               | Commit coherence        | `abc123def456`          |
| `fingerprint`     | Generation token (from merge-train candidate fingerprint, or timestamp hash) | Cycle isolation         | `gen-5` or `1693468800` |
| `sequence`        | Call order within cycle (0-indexed)                                          | Retry ordering          | `0`, `1`, `2`, etc.     |

**Example**: `ci-recovery-router:9876543210:1234:abc123def456:gen-5:0`

### Ownership Transitions

| Transition    | Triggered By                       | Action                                      | TTL               | Next Owner      |
| ------------- | ---------------------------------- | ------------------------------------------- | ----------------- | --------------- |
| **Acquire**   | CI Recovery `operation: reconcile` | Write lease_id to state comment             | 5 min             | (current owner) |
| **Heartbeat** | CI Recovery completes successfully | Renew expiry timestamp                      | +5 min from now   | (current owner) |
| **Takeover**  | Lease expiry + 5 min grace         | New CI Recovery dispatch can acquire        | TTL + 5 min grace | (new caller)    |
| **Release**   | PR lands or is closed              | Delete lease_id from state comment          | —                 | (none)          |
| **Escalate**  | Lease conflict detected            | Stop all mutations, post escalation comment | —                 | (human)         |

### Failure Modes & Recovery

| Failure            | Detection                                                              | Recovery                                                                    |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Lease Conflict** | New caller finds active lease_id not matching caller's idempotency key | Fail closed: skip mutations, post conflict comment, wait for expiry + grace |
| **Expired Lease**  | New caller checks expiry timestamp                                     | Acquire new lease (old owner is presumed dead)                              |
| **Lost Lease**     | State comment not found or lease_id cleared externally                 | Log warning, re-acquire on next cycle                                       |
| **Dangling Lease** | PR is closed but lease_id not released                                 | Scheduled maintenance job cleans up stale leases (separate 1-hour sweep)    |

---

## Contract Validation in CI

### Validation Job Specification

**Trigger**: Every push to main, every PR opened/updated (via CI workflow)  
**Location**: `.github/workflows/goobers-contract-validation.yml` (new workflow)  
**Timeout**: 5 minutes

**Steps**:

1. Checkout `.github/workflows/ci-recovery*.yml`, `.github/workflows/merge-train*.yml`, `.github/workflows/goobers-*.yml`
2. Checkout `.github/scripts/ci-recovery/`, `.github/scripts/merge-train/`, `.goobers/workflows/`
3. Run Node.js script: `node .github/scripts/validate-goobers-contracts.mjs`
   - Parse each workflow inputs spec
   - Validate against `crawler.goobers.invocation/v1` schema
   - Validate each script's fixture cases against schema
   - Report field-level failures (unknown field, type mismatch, missing required)
4. Run: `npm run test:unit -- tests/unit/goobers-run-workflow.test.ts`
5. Run: `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
6. Report: Exit non-zero if any validation fails

**Output**: Markdown summary with pass/fail per workflow + per fixture

---

## Documentation Updates (Canonical Homes Only)

1. **`.goobers/README.md`**: Add "Contract Version" section explaining v1 schema versioning and breakage handling
2. **`docs/guides/ci-recovery.md`** (or new): Explain lease acquisition, heartbeat, takeover, and escalation; link to schema
3. **`docs/guides/merge-train.md`** (or new): Explain FIFO admission, candidate validation, promotion atomicity
4. **`docs/agent-os/policies/ci-config-knobs.md`**: Add any new tunable constants introduced (none in Phase 0)

---

## Exit Gate to Phase 1

✅ **Phase 0 is complete when**:

- [ ] 100% mutation paths inventoried in this document with file+line links
- [ ] Contract schema files committed and enforced by CI job
- [ ] Deterministic invariant checks all pass
- [ ] Lock/lease design reviewed and model transitions documented
- [ ] Documentation updated in canonical homes
- [ ] CI validation job runs green on main
- [ ] All targeted tests pass: `npm run test:unit -- tests/unit/goobers-run-workflow.test.ts tests/unit/ci-recovery-router-run-name.test.ts tests/unit/merge-train-workflow-wakeups.test.ts tests/unit/merge-train-validate-publish.test.ts tests/unit/ci-knobs-guard.test.ts`
- [ ] Node tests pass: `node --test .github/scripts/ci-recovery/*.test.mjs .github/scripts/merge-train/*.test.mjs`

**Gate**: No shadow-mode run starts until ALL acceptance criteria are met.
