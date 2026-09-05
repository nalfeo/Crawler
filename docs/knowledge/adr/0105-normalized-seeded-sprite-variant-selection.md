# ADR 0105: Normalize sprite concepts before seeded variant selection

## Status

Accepted

## Date

2026-09-04

## Estimated Complexity

🍎 x 2 — extends the existing shared registry and spawn-time appearance seam without adding a new system.

## Context

Generated sprite variants can describe the same visual concept with historically
different IDs. For example, `npc-welcome-goon`, `welcome-goon`, and
`welcome-goon-v2` all mean the welcome goon, but the registry currently groups
entries by exact `briefId`. Exact grouping fragments the accepted pool and can
leave accepted art unreachable.

The runtime also needs a durable exclusion rule for variants that were accepted
but later marked disliked. Selection must remain deterministic for a fixed world
seed and entity-spawn sequence, must never use `Math.random`, and must agree
between the visual renderer and headless simulation.

ADR 0028 and the 2026-06-30 mob-appearance ADR established multi-variant
registries and spawn-time variant rolls. ADR 0086 removed generation-lineage
suffixes from newly approved IDs. This decision extends those contracts to
legacy aliases and dislike eligibility without approving, deleting, or
otherwise mutating art.

The existing `scripts/sprites/sprite-name-taxonomy.ts` contract also carries
`DESIGN_NAME_REMAP`, including the load-bearing `angry-roomba-v2` design-name
exception. Runtime normalization cannot independently reimplement that rule
without eventually disagreeing with approval and migration tooling.

## Decision

- **IDN-001**: Add a dependency-free shared normalizer that removes a trailing
  `-var-N`, removes one trailing generation-lineage `-vN`, and removes the
  historical `npc-` role prefix. Registry grouping and lookup both use this
  normalized concept ID, so callers may use any equivalent historical form.
- **IDN-002**: Move generation-lineage normalization and design-name remaps to
  the shared helper. The existing sprite taxonomy imports that primitive and
  retains its public `bareConcept` API, establishing one canonical rule without
  reversing the dependency graph.
- **ELG-001**: Treat presence in the generated manifest as acceptance.
  Placeholder entries are always excluded from the runtime registry. In a
  normalized concept group with at least one non-disliked accepted survivor,
  lifecycle reconciliation removes disliked variants from the manifest, making
  them ineligible for runtime selection and preload. If every accepted variant
  in the group is disliked, the lifecycle deliberately retains the group
  unchanged and runtime-usable until a replacement is explicitly accepted; this
  prevents a concept outage. A manifest entry explicitly persisted with
  `disliked: true` remains directly ineligible.
- **RNG-001**: When an entity is assigned a new non-empty appearance key, derive
  a private `SeededRandom` from `hashStringToSeed` over the world seed, the
  entity's monotonic render generation (its spawn-sequence identity), and the
  appearance key, then assign one roll from that private stream. Registry
  presence and eligible-variant count never affect this step, and cosmetic
  selection consumes zero values from shared `world.rng`. A fixed seed and
  fixed spawn sequence therefore produce the same selection sequence in visual
  and default headless runs.
- **SEL-001**: Put roll-to-variant selection in one shared helper. It normalizes
  the requested concept, clamps the roll into `[0, 1)`, and indexes the
  deterministically sorted eligible pool. The visual texture resolver and the
  headless weapon-anchor resolver both call this helper.
- **PIN-001**: Exact NPC and set-piece texture pins remain exact and do not opt
  into per-entity random selection. A downstream deletion transaction must
  repoint every exact pin to an accepted, non-disliked replacement in the same
  validated write set or abort without changing any file.
- **APR-001**: Runtime eligibility is read-only. This contract never
  auto-approves art and does not infer acceptance from generation output.
- **LFC-001**: A stale dislike key may reconcile to an accepted manifest entry
  only by the tuple `(sourceRun basename, variantIndex)`. Zero matches remain
  fail-closed and unresolved without mutating or throwing; multiple matches are
  a hard ambiguity failure. Concept-name similarity must never authorize a
  mutation.
- **LFC-002**: Pending annotation overlays are not deletion authority. The
  existing queue flow must first promote them into tracked annotations before a
  lifecycle transaction may act on them.
- **LFC-003**: Deletion planning must compute full reference closure, including
  manifest shards, PNGs, catalogs, exact NPC/set-piece pins, and other generated
  references. It must emit a tombstone that preserves disliked concept demand
  for backlog/regeneration planning.
- **LFC-004**: Lifecycle mutation uses a staged write set under the existing
  mutation lock. Validate the complete staged result, including zero dangling
  references, before atomically applying it; any validation failure leaves the
  repository unchanged.
- **LFC-005**: Acceptance transactions that remove assets or change lifecycle
  annotations publish exactly once to the canonical `assets/queue` branch.
  Legacy `asset-checkin` issue publication cannot represent those changes and
  must not run afterward: a second fallible remote write would make local
  rollback unable to restore the already-published queue state.

## Consequences

### Positive

- **POS-001**: Legacy aliases resolve to one accepted variant pool instead of
  creating unreachable art islands.
- **POS-002**: Disliked variants are removed from runtime selection once their
  normalized group has a non-disliked accepted survivor, while an all-disliked
  group remains usable until replacement acceptance prevents a concept outage.
- **POS-003**: Visual and headless paths share the same deterministic
  roll-to-entry implementation.
- **POS-004**: Selection is reproducible from the run seed and spawn order while
  remaining varied across entities.
- **POS-005**: Tooling and runtime share lineage-remap semantics while exact art
  pins retain their authored identity.

### Negative

- **NEG-001**: Cosmetic assignment now owns a separate hash-input contract.
  Changing the hash fields, render-generation sequence, or appearance key
  changes which eligible variant an entity receives, even though gameplay RNG
  state and outcomes remain untouched.
- **NEG-002**: Adding another historical role prefix requires an explicit
  normalizer update rather than an implicit fuzzy-name heuristic.
- **NEG-003**: Exact-pinned surfaces do not automatically gain per-entity
  variety; changing that is a separate authored-contract decision.

### Risks

- **RSK-001**: A lifecycle producer that records dislike only in a side file and
  never projects it onto the accepted manifest cannot affect runtime
  eligibility. The downstream lifecycle slice must persist or compose the
  `disliked` field before registry construction.
- **RSK-002**: Removing arbitrary semantic prefixes could merge genuinely
  distinct concepts, so normalization deliberately removes only the known
  historical `npc-` alias.
- **RSK-003**: Stale annotations can name pre-migration texture IDs. The
  source-run/index reconciliation rule must fail closed when provenance is
  incomplete or non-unique.

## Alternatives Considered

### Keep exact brief-ID buckets

- **ALT-001**: **Description**: Require tooling migrations to rewrite every
  historical alias before runtime can see a unified pool.
- **ALT-002**: **Rejection Reason**: Existing accepted data remains fragmented
  until every producer and artifact is migrated, and future stale aliases can
  silently recreate the bug.

### Select with the shared gameplay RNG

- **ALT-003**: **Description**: Draw the appearance roll from `world.rng` when a
  normalized concept has multiple eligible variants.
- **ALT-004**: **Rejection Reason**: Registry injection differs between the real
  game and default headless runs, so conditional shared-stream draws break
  real/headless seed parity and can alter later gameplay outcomes.

### Filter dislikes only in the renderer

- **ALT-005**: **Description**: Load every accepted entry and skip disliked keys
  only when Phaser resolves a texture.
- **ALT-006**: **Rejection Reason**: Headless and visual paths could diverge,
  and disliked assets would remain preloadable despite being ineligible.
