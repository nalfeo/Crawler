# Epic: Lookbook-grounded set-piece pipeline overhaul

**Status:** Planned  
**Owner:** Producer / Set Piece Designer  
**Estimate:** 8🍎 implementation work, delivered as dependency-ordered slices  
**Primary pilot:** `welcome-room-v2`

## Outcome

Replace the current layout-first plus screenshot-judge workflow with a
lookbook-grounded pipeline that produces rooms as authored, inspectable
artifacts:

1. a lore-safe room brief and room art contract;
2. a native-resolution pre-decomposition blockout;
3. provenance-backed, semantically verified asset selections;
4. a decomposed runtime layout with deterministic geometry/style gates; and
5. a real-engine capture plus pixel-grounded subjective evaluation.

The updated interior lookbook is a design reference, not an authority for game
lore or asset identity. Its durable synthesis must be canonicalized into
versioned repository guidance and explicit contracts rather than re-read
informally by each agent.

## Epic hard gate

The overhaul is complete when three representative rooms (Welcome Room,
one danger-focused room, and one Earth-artifact or civic room) can each be
replayed from brief to runtime capture with:

- a validated room art contract, provenance record, and pre-decomposition
  target;
- zero semantic asset/mapping errors and zero illegal wall-orientation
  placements;
- all deterministic geometry, scale, circulation, focal, and shell checks
  passing;
- a real-engine capture with declared pixel-review regions; and
- an advisory scorecard with every required dimension at or above 6/10,
  with no unresolved lore contradiction.

The existing runtime/gameplay contracts must remain unchanged unless an
explicit systems decision and regression evidence approve a change.

## Design principles

- **Canon before composition:** lore sources and the room's narrative verb are
  resolved before layout decisions.
- **Floorplan before props:** zones, circulation, focal hierarchy, negative
  space, and camera contract precede decomposition.
- **Semantic grounding is not filename matching:** an asset ID is valid only
  when its manifest/brief provenance and depicted object agree.
- **Native-scale evidence first:** judge silhouettes and spacing at the game's
  native pixel scale; nearest-neighbor enlargements are for inspection only.
- **Deterministic gates before subjective review:** a judge cannot rescue a
  geometrically invalid or unmapped room.
- **Real artifact over lab-only proof:** final wiring is observed in the game or
  headless runtime, not only in the set-piece lab.

## Dependency graph

```text
P0 Mapping integrity repair (external prerequisite)
 |
 +--> P1 Canonical lookbook + room-contract schema
 |     |
 |     +--> P2 Pre-render/blockout artifact and editor handoff
 |     |     |
 |     |     +--> P5 Welcome Room migration
 |     |
 |     +--> P3 Deterministic geometry/style/orientation gates
 |     |     |
 |     |     +--> P5 Welcome Room migration
 |     |
 |     +--> P4 Provenance and semantic asset validation
 |           |
 |           +--> P5 Welcome Room migration
 |
 P1 + P2 + P3 + P4 --> P5 Welcome Room migration
 P5 + P6 --> P7 Representative-room rollout and CI adoption
 P6 Pixel-grounded visual evaluation surface
```

`P0` is currently owned by the separate **Sprite mapping corruption** session.
No visual baseline or asset-quality conclusion from the current Welcome Room
captures is trusted until P0 is resolved.

## Implementation slices

### P0 — Repair and guard asset mapping integrity

**Owner:** Asset Forge + DevOps  
**Estimate:** 1–2🍎  
**Scope:** generated manifest, sprite maps, brief IDs, asset metadata, mapping
audit scripts and tests.

Resolve the repository-wide ID-to-image corruption, including the known
bookcase/goblin mismatch and stale Spell Broker pin. Add a deterministic audit
that rejects missing files, duplicate/conflicting IDs, and manifest entries
whose semantic type/provenance is inconsistent.

**Exit evidence:** the mapping audit is green for the generated catalog and
the Welcome Room's core/stage packs resolve to the intended depicted objects.

### P1 — Canonicalize the lookbook into room contracts

**Owner:** Content Designer + DevOps  
**Estimate:** 1–2🍎  
**Scope:** `docs/knowledge/game-design/`, room-contract schema, agent/skill
instructions, provenance format.

Turn the updated lookbook's durable guidance into a versioned canonical
reference: projection, silhouette/readability, palette and lighting contracts,
wall-orientation rules, density principles, archetype guidance, and explicit
non-rules. Define how lore sources, user canon, lookbook references, and
intentional deviations are recorded.

**Exit evidence:** a schema-valid room contract can cite lore and lookbook
claims without treating visual references as lore or asset identity.

### P2 — Add the pre-decomposition blockout stage

**Owner:** Set Piece Designer + Systems Engineer  
**Estimate:** 1–2🍎  
**Scope:** blockout artifact format, set-piece editor import/export, evidence
validator, room authoring workflow.

Make the native-resolution blockout a first-class artifact with zones,
circulation, focal bounds, negative space, NPC silhouettes, relationship
markers, and decomposition status. The blockout must be reviewable before
individual props are selected or generated.

**Exit evidence:** `welcome-room-v2` can be loaded, edited, validated, and
handed to decomposition without reconstructing geometry from final props.

### P3 — Expand deterministic composition and legality gates

**Owner:** QA Engineer + Systems Engineer  
**Estimate:** 1–2🍎  
**Scope:** `scripts/agent/set-piece/composition-score.ts`, validators, unit
and fixture tests.

Preserve existing geometry checks and add gates for:

- back-wall-only forward-facing prop placement;
- orientation legality by prop class;
- declared feet dimensions versus native sprite footprint;
- neighboring scale coherence;
- focal dominance and readable negative space;
- semantic asset identity and mapping status; and
- evidence-to-runtime drift.

Thresholds must remain reference-backed; never loosen a threshold merely to
make a room pass.

**Exit evidence:** malformed placement, wrong-facing wall art, declared-vs-
depicted asset mismatches, and scale outliers fail with actionable diagnostics.

### P4 — Make asset grounding flow into briefs and approval

**Owner:** Asset Forge + Content Designer  
**Estimate:** 1–2🍎  
**Scope:** prop inventory, prop briefs, generated manifest metadata, judge/
approval handoff.

Prop decomposition must consume the room art contract and emit briefs carrying
room role, semantic object type, scale class, orientation, palette/light
constraints, provenance, and rejection rationale. Approval must verify the
asset against the brief, not only sensor scores or filenames.

**Exit evidence:** every selected Welcome Room prop has traceable brief →
candidate → approved asset provenance and a semantic identity check.

### P5 — Migrate and iterate the Welcome Room

**Owner:** Set Piece Designer, with Content and Asset Forge  
**Estimate:** 1–2🍎  
**Dependencies:** P1, P2, P3, P4, and resolved P0  
**Scope:** `welcome-room-v2`, evidence sidecar, pre-render target, runtime
layout, replacement/commissioned props.

Re-capture only after mapping repair. Use the canonical lore: former-contestant
Welcome Goon, Director-created Sweaty Merchant and Spell Broker, one shared
room across uncountable seasons, and a relationship that cycles between
lovers, friends, and enemies. Do not freeze an invented relationship state.

**Exit evidence:** the room passes all deterministic gates, reads correctly at
native scale, and is observed in the real runtime with no mapping or
orientation defects.

### P6 — Build a pixel-grounded subjective evaluation surface

**Owner:** UX Designer + QA Engineer  
**Estimate:** 1–2🍎  
**Scope:** real-engine review setup, `window.__visualReview` regions,
screenshot/eval artifacts, scorecard schema and reporting.

Declare review regions for shell, circulation, focal cluster, NPCs, wall
decor, and scale comparisons. Require the evaluator to inspect native-scale
and nearest-neighbor views, while keeping screenshot-only findings explicitly
non-authoritative. Store scorecards with evidence links and unresolved
findings.

**Exit evidence:** a deliberately broken fixture produces a region-specific
finding, while a valid room produces a complete scorecard without phantom
layout panes or stale captures.

### P7 — Generalize to representative archetypes and CI

**Owner:** Producer + Set Piece Designer + DevOps  
**Estimate:** 1–2🍎  
**Dependencies:** P5 and P6  
**Scope:** one danger-focused room, one civic/Earth-artifact room, CI guards,
documentation and handoff templates.

Apply the pipeline to two additional archetypes without copying Welcome Room
assumptions. Add CI checks for contract validity, mapping integrity,
orientation legality, evidence drift, and required real-engine/eval artifacts.
Keep subjective judging advisory and deterministic CI authoritative.

**Exit evidence:** the epic hard gate passes for all three representative
rooms, with independently replayable artifacts.

## Explicit non-goals

- Rebalancing combat, economy, progression, or room difficulty.
- Rewriting existing lore to fit a visual reference.
- Replacing the generated-art pipeline or introducing a new asset backend.
- Making an LLM judge authoritative in CI.
- Migrating every existing set piece before the representative-room gate is
  proven.

## Risk register and decisions

| Risk                                           | Mitigation / decision                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Corrupt mappings invalidate visual conclusions | P0 blocks all visual baselines.                                                                    |
| Lookbook has no numeric density data           | Keep thresholds explicit and label them as project policy until measured reference fixtures exist. |
| Subjective judge misses semantic errors        | Put semantic identity and orientation in deterministic gates; judge only reviews presentation.     |
| Room contracts drift from runtime JSON         | Validator compares evidence, authored layout, and runtime capture setup.                           |
| Lore gets invented during decomposition        | Require canon-source citations and contradiction flags before blockout approval.                   |
| Work balloons into a rewrite                   | Ship the three-room gate first; defer broad migration.                                             |

## Planned artifacts

- Canonical lookbook synthesis and room-contract schema
- Room-contract and provenance validator
- Native pre-decomposition blockout format/editor path
- Composition, orientation, scale, and semantic mapping gates
- Brief/asset approval contract updates
- Pixel-grounded set-piece review surface and scorecard
- Welcome Room migration
- Representative-room rollout and CI integration

This file is the high-level epic design. Each implementation slice must still
produce its own bounded brief, tests/evidence, and handoff; no slice should
silently absorb another slice's ownership.
