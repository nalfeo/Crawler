# ADR 0073: Phased Theme Equipment Set Pipeline

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 3 — asset-pipeline tooling, automation, and canvas work under the tooling-only cap

## Context

Crawler needs reusable themed equipment art that can become both base items and later
visual variants through palette shifts, scaling, and effects. Generating each item as an
independent `asset-request` does not preserve collection cohesion: the current worker runs
brief synthesis through variant selection without review pauses, and the publisher can
publish each completed request independently.

A themed set must cover at least five weapon types and at least two-thirds of the current
non-hand equipment slots. Reviewers need to evaluate every item and the complete set at
roster, brief, sprite-sheet, and variant-selection phases. Existing per-sprite sensors and
the VLM judge remain authoritative for individual art, but their `theme_adherence` axis only
receives hard-coded floor/family addenda today.

The Constitution prohibits nondeterministic LLM judgments as CI gates. ADR 0043 narrowly
allows the trusted asset-request workflow to call paid synthesis and vision providers. A
set-level collection judge requires an equally narrow authorization, bounded cost, durable
state, and explicit human control.

## Decision

- **DEC-001**: Model a theme as one durable set with four ordered review phases:
  `roster`, `briefs`, `sprite-sheets`, and `variant-approval`.
- **DEC-002**: Persist set state under `theme-sets/<set-id>/state.json` in the configured
  `RunStore`. Canvas instance IDs are never persistence keys.
- **DEC-003**: Require every item and the set-level human review to pass before phase
  advancement. A set-level cohesion score below 3/5 also blocks advancement.
- **DEC-004**: Freeze passing items within a phase. Only rejected items receive a new
  revision; the collection judge then reevaluates the complete frozen-plus-revised set.
- **DEC-005**: Add explicit arbitrary theme context to synthesized and loaded briefs. The
  existing per-sprite `theme_adherence` evaluator consumes that context in addition to
  existing floor/family addenda.
- **DEC-006**: Run collection judgment once per phase revision. Roster and brief phases use
  one structured text call. Sprite-sheet and variant phases use one deterministic contact
  sheet and one structured vision call. A theme set is capped at 32 items.
- **DEC-007**: Authorize collection-judge provider calls in CI only from the dedicated,
  trusted theme-equipment workflow with the same maintainer-only trust boundary and Azure
  credentials used by ADR 0043. The judge is never part of deterministic test or merge
  gates. Provider calls remain dependency-injected and budgeted.
- **DEC-008**: Hold theme-set members out of the ordinary per-request publisher. Final
  publication combines all selected assets into one `runQueueCommit` operation so a set
  reaches the canonical asset PR as one payload.
- **DEC-009**: Use a project canvas as the human phase-control surface. Mutations require a
  per-instance token, trusted loopback origin, JSON content type, bounded request body, and
  authoritative phase-gate revalidation.

## Amendment 2026-07-25 — set index and model-proposed rosters

The pipeline shipped agent-first: the canvas required a caller-supplied `setId`, so it could
neither enumerate the sets that exist nor author a new one. In practice that made the human
surface unusable without an agent turn for every step. This amendment adds four decisions.

- **DEC-010**: The canvas opens without a `setId` and boots into a **set index** built by a
  `list` command over the authored plan directory unioned with `theme-sets/` in the `RunStore`.
  The index distinguishes "no durable state" from "store unavailable" so a storage outage never
  renders as an uninitialized set. Set selection is validated against a server-computed allowlist
  derived from that same `list`, so a client can never select an arbitrary id.
- **DEC-011**: A model may propose the **item roster only**. `themeDesignLanguage` stays
  human-authored; synthesis never derives a collection's visual identity. Proposals are validated
  by re-running the same `buildThemeEquipmentSetStateFromPlan()` authority that validates
  hand-written plans, so schema, duplicate-id, unknown-slot, and coverage rules have exactly one
  judge. A bounded repair loop feeds the deterministic failure back to the model and hard-fails
  rather than relaxing coverage thresholds.
- **DEC-012**: `save-plan` derives its target path server-side from the validated `plan.id`. The
  client supplies no path. Plans are **immutable once durable state exists** for that set id, with
  no override flag — the phase state machine is keyed to the roster it was initialized with, so a
  changed roster requires a new set id.
- **DEC-013**: Workflow dispatch pins `--ref` to the resolved current branch and, for `init`,
  verifies the plan blob exists on that remote ref before dispatching. `gh workflow run` without
  a pinned ref silently targets the default branch, which would have run a set against a plan
  that does not exist there.

## Consequences

### Positive

- **POS-001**: Reviewers can judge silhouette diversity, shared visual language, and reuse
  potential before spending later-stage Azure credits.
- **POS-002**: Passing work remains stable across iterations, avoiding unnecessary
  regeneration while preserving whole-set judgment.
- **POS-003**: Existing synthesis, generation, sensor, VLM, RunStore, and queue-commit
  primitives remain the implementation engines.
- **POS-004**: A themed set cannot leak partial assets into the canonical asset PR.

### Negative

- **NEG-001**: A set takes multiple explicit review/advance cycles instead of one unattended
  request run.
- **NEG-002**: Theme state and item revisions add orchestration data beyond existing
  issue-scoped checkpoints.
- **NEG-003**: Collection judgments add up to four paid provider calls per clean set, plus
  additional calls after rejected-item revisions.

### Risks

- **RSK-001**: A provider outage can block a phase even when human reviews are complete;
  failures must remain visible and retryable without advancing state.
- **RSK-002**: Contact-sheet downscaling can hide item detail; individual sprite judgment
  remains required and collection judgment only evaluates cohesion.
- **RSK-003**: Concurrent canvas/workflow mutations could overwrite review state; writes
  must use revision compare-and-swap semantics.
- **RSK-004**: A theme prompt can encode stereotypes or weak cultural assumptions; the
  reviewer must reject caricatured concepts and preserve respectful theme direction.

## Alternatives Considered

### Independent Asset Requests

- **ALT-001**: **Description**: Generate and publish each equipment item through the existing
  request pipeline with only a shared theme sentence.
- **ALT-002**: **Rejection Reason**: It cannot pause the complete set between phases or
  prevent partial publication, and per-item theme adherence does not measure collection
  cohesion.

### Regenerate the Entire Set on Any Failure

- **ALT-003**: **Description**: Treat every revision as a fresh generation of all items.
- **ALT-004**: **Rejection Reason**: It wastes Azure credits, discards approved work, and
  introduces avoidable visual drift. Frozen passing items plus whole-set reevaluation
  preserves cohesion without full regeneration.

### Local-Only Theme Orchestration

- **ALT-005**: **Description**: Keep theme plans and all provider calls in one developer
  worktree.
- **ALT-006**: **Rejection Reason**: Sets exceed the project's local broad-run threshold,
  local state is not durable across sessions, and the existing Azure/GitHub pipeline already
  provides resumable infrastructure.
