# Session Handoff: Floor 2 Design — Family Territories & Relationships

## Date

2026-07-01

## Persona(s) adopted

**Producer** (lead) for a multi-layer, ambiguous design task, routing to **Content
Designer** + **Story Designer** (the 18-family roster, 18 resources, emergent events,
Director tone) and an **Architect/Systems-Designer** mindset (the spec + ADR covering
core ECS, AI, map-gen, quests, win conditions, and HUD). No code layer was touched —
this is a design-docs deliverable.

## Routing verdict

🧩 Needed Producer to split — the brief spans content, story, five engine subsystems,
and UX, so it was decomposed into a content bible + a system spec + an architecture ADR
rather than handled by a single specialist.

## Apples

Estimated: 🍎 x 5 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 📈 Over — the design scope is massive (an entire systemic floor), but delivering
it as docs-only carried none of the build/test/integration/debug risk that characterizes
a true 5🍎 code session; research + authoring completed in one focused pass.

Hello kitties: 4/5 = 0.80 🎀

## Review Harness

N/A — docs/design-only diff (no `src/` or test changes). Exempt from the
`pr-review-ledger` guard per the review-harness policy. The relevant gate for this
deliverable is `npm run docs:check`, which passes (exit 0, 0 blocking).

## What Was Done

Delivered the complete **Floor 2 design package** as committed docs:

1. **Content bible** — `docs/knowledge/game-design/floor2-families-and-resources.md`:
   18 mob families (roster ≥15; floor seeds 3–4) with boss, AI archetype, HUD color,
   refinement style, and signature hook; 18 contested resources (floor seeds 1); the
   0–100 relationship bands + levers; boss/den unlock-objective pool; the two win shapes;
   ≥8 trash mobs; the settlement (1–2 seeded shops + "The Broker" quest-giver); and 6
   emergent relationship events. Dark-comedy "Family Matters" reality-TV framing.
2. **System spec** — `.specify/specs/floor2-family-territories.md`: 20 numbered
   requirements + Design (data model, `FamilyMembership` component, `factionRelations`
   map, systems, cave generator, 8-slice follow-up plan), a Test Plan, and a
   Constitutional Compliance table.
3. **ADR 0040** — `docs/knowledge/adr/0040-floor2-family-territory-and-relationship-architecture.md`:
   eight decisions (D1 family-level relationship state; D2 pure bands + hate speed-ramp;
   D3 seeded data-driven selection; D4 reuse Team/goal-flags/quests/door-lock/sealing;
   D5 band-keyed AI foe-set; D6 `BiomeType.CAVE_SYSTEM` reusing rot-js `ROT.Map.Cellular`;
   D7 per-tick win evaluator → resource-heart stairs; D8 settlement/shops/HUD), plus
   consequences, risks, and five rejected alternatives.
4. **Index updates** — ADR README (by-number row + "Floors/map-gen" thematic line +
   fixed the stale "next unused number" pointer), specs README (Current-specs row), and
   a GDD Floor-Design pointer to the new docs.
5. **Fixed a pre-existing docs-gate blocker** — `2026-06-30-mob-appearance-multiplayer-variants.md`
   referenced a wildcard test path (`tests/unit/phaser-bridge*.test.ts`) the ADR
   path-checker resolves to a non-existent parent; replaced it with the three real
   `phaser-bridge*` test files so `check-adr-consistency` is unblocked.

## What's Next

Implementation is sliced into **8 follow-up PRs** (see the ADR/spec §Follow-up):
(1) faction data + `FamilyMembership` + `factionRelations` + relationship system + lab;
(2) `CaveSystemGenerator` + `BiomeType.CAVE_SYSTEM` + roles; (3) family-aware AI (bands,
hate ramp, feud targeting, ally defend); (4) bosses + sealed dens + seeded unlock
objectives; (5) dynamic win evaluator + resource-heart stairs; (6) settlement + seeded
shops + emergent-event quests; (7) `HudFamilyRelationships` widget + minimap territory
tint; (8) scenario wiring + Governor seed-sweep balancing (90% win-rate) + Director
narration. Each slice needs its own lab and tests; start with slice 1 (data + relationship
model) since everything else reads `factionRelations`.

## Blockers

None blocking this deliverable. Note two **pre-existing, out-of-scope** issues for a
future code session:

- **3 sprite TEST typecheck errors** surfaced by preflight
  (`tests/unit/sprites/asset-queue.test.ts:117`, `tests/unit/sprites/issue-pipeline.test.ts:277,333`)
  — unrelated to floor design; not touched here.
- **3 non-blocking `docs:check` warnings** — ADRs `0034-config-driven-sprite-wiring.md`,
  `0034-quarter-tile-fov-resolution.md`, and `2026-06-30-mob-appearance-multiplayer-variants.md`
  use an inline `**Status:**` field instead of a `## Status` heading, which the checker
  warns on (non-blocking). Left as-is to avoid restyling other agents' ADRs.

## Branch State

- Branch: `nalfeo-floor-2-design`
- All tests passing: N/A — docs/design-only session; full `verify` not run. `npm run
docs:check` passes (exit 0, 0 blocking).
- PR created: no (not requested).

## Agent-OS Telemetry

N/A — no `files/guard-telemetry.jsonl` present this session.

## Test Results

`npm run docs:check` → **exit 0, 0 blocking** across all sub-checks (paths, adr
consistency, readme commands, personas, stale-game-design, apple calibration, guard
telemetry). The new game-design doc shows the expected "no git history (untracked or new
file)" info line. `check-adr-consistency` → 0 blocking (3 pre-existing Status warnings).

## Key Decisions Made

- **Relationship state is family-level** (`world.factionRelations: Map<FamilyId,number>`),
  not per-mob — mobs carry only `{familyId, isBoss}`. Cheaper and matches the HUD.
- **Reuse, don't rebuild** — Team enum, goal flags, the data-driven quest system,
  door-lock, generic special-room sealing, and the boss-stair stair-spawn plumbing all
  serve Floor 2; the resource heart reuses the boss-stair role.
- **Open caverns via rot-js `ROT.Map.Cellular`** behind a new `CaveSystemGenerator` /
  `BiomeType.CAVE_SYSTEM` rather than hand-rolled cellular automata (build-on-existing-dep).
- **Two win shapes as a per-tick evaluator** (sole-ally>75 OR all-bosses-dead) latching
  `floor2-victory`, not a single hard-coded objective.
- **Docs split into three files** (content bible / spec / ADR) rather than one, so the
  creative roster, the contract, and the architecture each have a clear home.

## Retrospective

### Lessons Learned

- The `docs:check` **ADR path-checker** (`check-adr-consistency.ts`) only treats a
  backticked string as a path if it starts with a known prefix (`src/`, `tests/`, …) **or**
  ends with a code ext **and contains a slash**. Practical rule for referencing
  not-yet-created files in an ADR: use the **bare filename** in backticks (no slash, e.g.
  `families.json`, `CaveSystemGenerator`) and name the existing parent dir separately.
  Full slashed paths are validated with `statSync` and must exist.
- Its glob handling is naive: for `dir/prefix*.test.ts` it takes the substring **before
  the first wildcard** as the parent, so `tests/unit/phaser-bridge*.test.ts` fails
  (parent `tests/unit/phaser-bridge` isn't a dir) even though files match. Prefer
  explicit file lists over inline wildcards in ADRs.
- The ADR README's "next unused number" pointer (and by-number table) is hand-maintained
  and **stale** — verify against `Get-ChildItem docs/knowledge/adr` before picking a
  number. 0034 was already used ×3; I took **0040**.
- Spec files (`.specify/specs/`) and game-design docs are **not** path-scanned by any
  docs gate — only ADRs and the core doc set are. Still kept them accurate.

### Mistakes Made

- Initially planned to reference proposed files with full paths in the ADR, which would
  have failed the path-checker. Caught it by reading `check-adr-consistency.ts` first and
  pre-verifying every candidate path with `Test-Path` before writing — worth the upfront
  step. Early signal for the next agent: **read the gate's source before writing docs it
  will scan.**

### Opportunities for Future Improvement

- `check-adr-consistency.ts` glob handling could actually expand globs (fast-glob) instead
  of the before-first-wildcard heuristic, and could accept the inline `**Status:**` field
  as satisfying the Status check — that would clear 3 long-standing warnings without
  restyling.
- The ADR README by-number table is missing rows for 0030–0034; a future docs pass should
  back-fill it (out of scope here to avoid a large unrelated diff).
- Consider a tiny generator that scaffolds `families.json`/`resources.json` skeletons from
  the content bible tables so slice 1 doesn't hand-transcribe 18 rows.
