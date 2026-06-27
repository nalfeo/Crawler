# ADR 0005: Parameterized Floor Configuration System

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 3 — mechanical floor1→floor parameterization across core/engine/game/bootstrap/labs/shared with aliased exports; no new lab required.

## Deciders

Nick Alfeo (Producer), Copilot

---

## Context

Crawler previously hardcoded "floor1" throughout the codebase in:

- Type definitions (Floor1Config, Floor1ScenarioState, etc.)
- File names (floor1Scenario.ts, floor1-config.ts, etc.)
- Function names (initializeFloor1Scenario, createFloor1GameConfig, etc.)
- Import paths and module exports

This hardcoding created a coupling between game logic and floor identity, preventing:

1. **Dynamic floor loading** — loading different floors at runtime
2. **Multi-floor progression** — advancing from floor1 → floor2 → floor3
3. **Modular floor content** — adding new floors without code changes

The project already had floor infrastructure in place (floor-manifest.ts, floor-registry.ts) designed to support multi-floor, but it was underutilized.

---

## Decision

**Parameterize all floor-dependent code to use a `floorId` parameter and the `floor-registry` system, eliminating all hardcoded "floor1" references from game logic.**

### Implementation Strategy

1. **Generalize type names:** `Floor1*` → `Floor*` (FloorConfig, FloorScenarioState, etc.)
2. **Rename files:** Remove floor1 from file names (floor1Scenario.ts → floorScenario.ts)
3. **Parameterize functions:** Accept `floorId` parameter; load config via `getFloorConfig(floorId)`
4. **Maintain backward compatibility:** Export old names as aliases to avoid breaking existing code
5. **Centralize floor loading:** Use floor-registry as single source of truth

### Scope of Changes

**Affected Layers:**

- **src/core/** — GameWorld type references (minimal)
- **src/engine/** — HUD components updated to accept floorId context
- **src/game/** — Scenario initialization, systems, AI progression
- **src/bootstrap/** — Game config and scene setup functions
- **src/labs/** — All labs updated to use parameterized APIs
- **src/shared/** — Core config, manifest, registry, types

**Files Modified:** 34 total (14 renames, 20 updates)  
**Functions Affected:** ~20 game functions now accept floorId parameter  
**Impact:** 607 insertions, 69 deletions

---

## Positive Consequences

✅ **Enables multi-floor progression.** Game can now load floor1, floor2, floor3, etc. dynamically without code changes.

✅ **Configuration-driven floor data.** All floor-specific parameters (enemies, timers, objectives, map config, NPCs) are now in JSON manifests, not code.

✅ **Eliminates code-floor coupling.** Floor identity is a parameter, not baked into type/function names.

✅ **Reduces onboarding friction.** New floors can be added by creating a manifest file + JSON data files; no code review needed for content.

✅ **Backward compatible.** No breaking changes. Existing code continues to work via aliased exports.

✅ **Registry-driven extensibility.** New floors can be registered dynamically at runtime via `registerFloorManifest(floorId, manifest)`.

✅ **Clearer architecture.** Separation of concerns: game systems handle any floor; floor content is data.

---

## Negative Consequences & Risks

⚠️ **Slight runtime overhead.** Manifest lookups via registry; negligible for a roguelike.

⚠️ **Function signature churn.** All callers of floor-dependent functions now pass floorId; code impact is large but mechanical.

⚠️ **Boss config still partially hardcoded** (lines 172-180 in floor-config.ts). Boss HP/speed should move to enemy-packs.json; documented as technical debt.

⚠️ **No floor progression UI yet.** Game doesn't advance from floor1 → floor2; floor selection logic must be implemented separately.

---

## Alternatives Considered

### 1. Keep Hardcoded "floor1" + World State

**Description:** Store current floor ID in GameWorld; avoid parameterization.  
**Pros:** Smaller diff; less function signature churn.  
**Cons:** Hard-coded file/type names remain; prevents testing multiple floors in same session; floor identity still hidden in imports.  
**Rejected:** Doesn't solve the fundamental coupling problem.

### 2. Partial Parameterization (Only Config)

**Description:** Rename files/types but don't parameterize function signatures.  
**Pros:** Cleaner function calls; less parameter threading.  
**Cons:** Functions still assume "current floor"; can't load floor2 in parallel; harder to extend.  
**Rejected:** Creates inconsistency; parameterized types but hardcoded functions.

### 3. Component-Based Floor Context

**Description:** Add a FloorContext component to GameWorld; read floorId from that.  
**Pros:** Reduces parameter threading.  
**Cons:** Adds entity storage overhead; requires world mutation during initialization.  
**Rejected:** Overkill for current scope; parameterization is simpler.

---

## Validation

**Testing:** All 830+ unit tests pass. No regressions.  
**Typecheck:** Strict TypeScript; 0 errors.  
**Backward Compat:** All old exports aliased; existing code works unchanged.  
**Integration:** Dev server launches; all labs functional.

---

## Consequences for Future Decisions

1. **Floor progression logic** must parameterize the floor ID passed to initialization functions.
2. **Floor-specific dialogue/lore** should be sourced from floor manifest, not code.
3. **Dynamic content generation** (AI/LLM) should query floor-specific data from manifest.
4. **Boss variants per floor** should be defined in enemy-packs.json, not floor-config.ts.

---

## Migration Path

**For existing code:** No migration needed. Old exports (`Floor1Config`, `floor1Config`) remain as aliases.

**For new code:** Use parameterized APIs (`FloorConfig`, `getFloorConfig(floorId)`).

**For floor2+:** Create manifest, data files, register in floor-registry; no code changes.

---

## References

- `src/shared/floor-registry.ts` — Floor registry system
- `src/shared/floor-manifest.ts` — Floor manifest schema
- `src/shared/data/floors/floor1.manifest.json` — Floor 1 manifest example
- `src/shared/floor-config.ts` — Parameterized config loader
- `src/shared/floor-types.ts` — Generalized floor state types

---

## Related ADRs

- ADR-0001 (if exists): ECS architecture & determinism
- ADR-0002 (if exists): Phaser bridge pattern
