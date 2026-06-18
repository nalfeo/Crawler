# Phase 4: Full NPC Spawn Abstraction

**Date**: 2026-06-18  
**Session**: Phase 4 completion of floor configuration refactoring  
**Branch**: `copilot/design-headless-runner-ai`  
**PR**: #150  
**Complexity**: 🍎🍎 (2 apples - as estimated in Phase 2-5 handoff)

## Summary

Completed Phase 4 of the floor configuration refactoring by implementing full NPC spawn abstraction. All NPC spawning is now data-driven via placement definitions in the floor manifest, replacing hardcoded position logic while maintaining full backward compatibility with existing systems.

**Test Results**: 1263/1264 passing (1 pre-existing Azure OpenAI Vision failure unrelated to this work)

## What Was Implemented

### 1. NPC Placement Data Schema ✅

**Files Created**:

- `src/shared/data/npcs.floor1.json` - Floor 1 NPC placement definitions (3 NPCs)
- `src/shared/floor1-npc-placements.ts` - Loader module with schema validation

**Schema Structure** (already existed in `src/shared/npc-placements.ts`):

```typescript
type NpcPlacementDef = {
  id: string; // Unique placement ID
  npcTypeId: string; // References NPC definition
  name: string; // Display name
  roomRole?: 'spawn' | 'safe' | 'shop' | 'boss_stair' | 'any';
  position?: { x: number; y: number }; // Explicit position override
  questId?: string; // Associated quest
  isQuestGiver: boolean;
  isMerchant: boolean;
};
```

### 2. Floor Manifest Integration ✅

**Files Modified**:

- `src/shared/floor-manifest.ts` - Added `npcPlacements?: NpcPlacementDef[]` field to schema
- `src/shared/data/floors/floor1.manifest.json` - Added complete NPC placement array

**Manifest NPC Placements**:

```json
{
  "npcPlacements": [
    {
      "id": "floor1-tutorial-goon",
      "npcTypeId": "tutorial-goon",
      "name": "Tutorial Goon",
      "roomRole": "spawn",
      "isQuestGiver": true,
      "isMerchant": false,
      "questId": "floor1-tutorial"
    },
    {
      "id": "floor1-spell-quest-giver",
      "npcTypeId": "spell-quest-giver",
      "name": "Spell Broker",
      "roomRole": "any",
      "isQuestGiver": true,
      "isMerchant": false,
      "questId": "floor1-boss-battle"
    },
    {
      "id": "floor1-shopkeeper",
      "npcTypeId": "shopkeeper",
      "name": "Sweaty Merchant",
      "roomRole": "shop",
      "isQuestGiver": true,
      "isMerchant": true,
      "questId": "floor1-shopkeeper-errand"
    }
  ]
}
```

### 3. Data-Driven Spawning Implementation ✅

**Files Modified**:

- `src/game/floor1Scenario.ts` - Added `spawnNpcFromPlacement()` function and refactored initialization

**Key Implementation**:

```typescript
function spawnNpcFromPlacement(
  world: GameWorld,
  placement: NpcPlacementDef,
  objectiveTiles: { ... }
): number {
  // Resolve position from room role or explicit position
  let x: number, y: number;

  if (placement.position) {
    // Explicit position override
    x = placement.position.x;
    y = placement.position.y;
  } else if (placement.roomRole) {
    // Resolve from room role mapping
    switch (placement.roomRole) {
      case 'spawn':
        x = objectiveTiles.welcomeOfficePos.x;
        y = objectiveTiles.welcomeOfficePos.y;
        break;
      // ... other cases
    }
  }

  return spawnNpc(world, x, y, placement.npcTypeId);
}
```

**Refactored Initialization Code**:

```typescript
// Before: Hardcoded NPC spawning
world.floor1.guideNpcEid = spawnNpc(
  world,
  world.floor1.objective.welcomeOfficePos.x,
  world.floor1.objective.welcomeOfficePos.y,
  'tutorial-goon',
);

// After: Data-driven from manifest
const npcPlacements = floor1Manifest.npcPlacements;
if (npcPlacements && npcPlacements.length > 0) {
  for (const placement of npcPlacements) {
    const eid = spawnNpcFromPlacement(world, placement, objectiveTiles);
    // Store EID for backward compatibility
    if (placement.npcTypeId === 'tutorial-goon') {
      world.floor1.guideNpcEid = eid;
    }
  }
} else {
  // Fallback to hardcoded spawning (backward compatibility)
  // ...
}
```

### 4. Backward Compatibility ✅

**Strategy**: Graceful degradation with fallback logic

- If `floor1Manifest.npcPlacements` is present: Use data-driven spawning
- If missing/empty: Fall back to hardcoded spawning (preserves old behavior)
- Store NPC EIDs in `world.floor1` fields for existing code dependencies
- No breaking changes to existing systems or tests

---

## Technical Architecture

### Configuration Flow

```
floor1.manifest.json → floor1Manifest (validated by FloorManifestDef)
                                ↓
                         npcPlacements array (NpcPlacementDef[])
                                ↓
                   initializeFloor1Scenario() iterates placements
                                ↓
                   spawnNpcFromPlacement() resolves room roles
                                ↓
                   spawnNpc() creates NPC entity with defId
                                ↓
                   Store EID in world.floor1 for backward compatibility
```

### Room Role Mapping

| Room Role    | Resolves To                | Use Case                  |
| ------------ | -------------------------- | ------------------------- |
| `spawn`      | `welcomeOfficePos`         | Tutorial Goon (start)     |
| `safe`       | `safeRoomPos`              | Safe room NPCs            |
| `shop`       | `shopRoomPos`              | Shopkeeper                |
| `boss_stair` | `staircasePos`             | End-of-floor NPCs         |
| `any`        | `spellQuestGiverPos`       | Flexible placement        |
| (explicit)   | `placement.position.{x,y}` | Override room-based logic |

### Key Design Decisions

1. **Schema Reuse**: Used existing `NpcPlacementDef` schema from Phase 4 foundation (defined in `src/shared/npc-placements.ts`)

2. **Manifest Integration**: Added `npcPlacements` as optional array to floor manifest, enabling per-floor NPC configuration

3. **Room Role Abstraction**: NPC placements reference room roles (`spawn`, `shop`, etc.) instead of hardcoded positions, allowing procedural room layout to determine actual spawn points

4. **Backward Compatibility Bridge**: Maintained existing `world.floor1.guideNpcEid`, `shopkeeperNpcEid`, `spellQuestGiverNpcEid` fields for systems that depend on these references

5. **Graceful Fallback**: If manifest lacks `npcPlacements`, falls back to original hardcoded spawning logic (zero risk of breaking existing floors)

---

## Validation Results

### Test Summary

```bash
$ npm run verify

Test Files  1 failed | 128 passed (129)
      Tests  1 failed | 1263 passed (1264)
   Duration  367.14s
```

**Failed Test**: `tests/integration/synth-to-generate.test.ts`  
**Reason**: Azure OpenAI Vision not configured (pre-existing, unrelated to Phase 4)

### All Validations Passed

- ✅ TypeScript compilation
- ✅ ESLint (no new warnings)
- ✅ Prettier formatting
- ✅ Dead code detection (no new issues)
- ✅ Unit tests (100% pass rate for affected systems)
- ✅ Integration tests (1 pre-existing failure)
- ✅ Backward compatibility (all floor1 initialization tests pass)

### No Regressions

- All existing NPC spawning behavior preserved
- All quest system interactions work unchanged
- No changes to NPC definitions or interaction logic
- Floor1 scenario tests continue to pass

---

## Apple Complexity Assessment

**Declared**: 🍎🍎 (2 apples - from Phase 2-5 handoff estimate)  
**Actual**: 🍎🍎 (2 apples)

**Reasoning**:

- Created NPC placement JSON file with 3 NPCs: 0.5 apples
- Extended floor manifest schema and updated floor1.manifest.json: 0.5 apples
- Implemented `spawnNpcFromPlacement()` function with room role resolution: 0.5 apples
- Refactored initialization to use data-driven spawning with fallback: 0.5 apples

**Verdict**: ✅ Delivered exactly on scope and estimate

---

## Benefits Delivered

### 1. Data-Driven Floor Configuration

NPCs are now fully specified in floor manifest JSON, enabling:

- Non-programmers to add/modify NPC placements
- Tools to procedurally generate floor configurations
- Easier balancing and iteration on NPC positioning

### 2. Extensibility

The system naturally supports:

- Multiple NPCs per room role
- Dynamic NPC counts per floor
- Position overrides when room role logic doesn't fit
- Floor-specific NPC configurations

### 3. Foundation for Future Floors

Floor 2+ can now define their own NPC placements in `floor2.manifest.json` without touching code:

```json
{
  "id": "floor2",
  "npcPlacements": [
    {
      "id": "floor2-blacksmith",
      "npcTypeId": "blacksmith",
      "name": "Grizzled Blacksmith",
      "roomRole": "shop",
      "isMerchant": true
    }
  ]
}
```

### 4. Backward Compatibility Maintained

Existing code continues to work:

- Labs that construct `world.floor1` manually still function
- Test fixtures using hardcoded positions unchanged
- Migration path is incremental, not forced

---

## Next Steps (Future Work)

### Phase 5 Completion: Multi-Floor Progression

**Estimate**: 🍎🍎🍎 (3 apples - from original handoff)

Now that Phases 2-4 are complete, Phase 5 can be implemented:

1. Add `floorId: string` parameter to MainGameScene constructor
2. Refactor bootstrap to pass floorId from registry
3. Implement floor transition on stair descent
4. Add state persistence for multi-floor runs (inventory, XP, health)
5. Create complete Floor 2 manifest with enemy pack + NPC placements
6. Integration test floor transitions

**Benefit**: Unlocks actual multi-floor roguelite gameplay with progression

---

### NPC Behavior Configuration (Future Enhancement)

**Estimate**: 🍎🍎 (2 apples)

Extend NPC placements to include behavior configuration:

```json
{
  "id": "floor2-wandering-merchant",
  "npcTypeId": "merchant",
  "name": "Wandering Merchant",
  "roomRole": "any",
  "isMerchant": true,
  "behavior": {
    "type": "patrol",
    "waypoints": ["spawn", "shop", "safe"],
    "speed": 1.0
  }
}
```

This would enable:

- Wandering NPCs (patrol routes)
- Conditional NPC spawning (if quest X complete)
- NPC state machines (hostile until quest complete)

---

### Procedural NPC Placement (Future Enhancement)

**Estimate**: 🍎 (1 apple)

Add NPC placement generation rules to floor manifests:

```json
{
  "npcPlacementRules": {
    "minMerchants": 1,
    "maxMerchants": 2,
    "questGiverProbability": 0.8,
    "loreKeeperProbability": 0.3
  }
}
```

This would support:

- Randomized NPC counts per run
- RNG-driven floor variety
- Conditional NPC spawning based on objectives

---

## Knowledge Transfer

### For Next Agent: Memory Facts

**NPC spawn abstraction**:

- Fact: NPC spawning is now data-driven via floor1Manifest.npcPlacements array; spawnNpcFromPlacement() resolves room roles (spawn/safe/shop/boss_stair/any) to positions from chooseObjectiveTiles(), maintaining backward compatibility via fallback to hardcoded spawning when npcPlacements is absent.
- Citations: src/game/floor1Scenario.ts:367-424 (spawnNpcFromPlacement), src/game/floor1Scenario.ts:587-625 (data-driven initialization), src/shared/data/floors/floor1.manifest.json:59-85 (npcPlacements array)

**Floor manifest NPC integration**:

- Fact: Floor manifest schema now includes optional npcPlacements field (array of NpcPlacementDef); floor1.manifest.json defines all 3 floor1 NPCs (tutorial-goon, spell-quest-giver, shopkeeper) with room roles instead of hardcoded positions.
- Citations: src/shared/floor-manifest.ts:133-135 (schema), src/shared/data/floors/floor1.manifest.json:59-85 (data)

---

## Files Modified

### New Files

- `src/shared/data/npcs.floor1.json` (27 lines)
- `src/shared/floor1-npc-placements.ts` (18 lines)

### Modified Files

- `src/shared/floor-manifest.ts` - Added `npcPlacements` field and import
- `src/shared/data/floors/floor1.manifest.json` - Added NPC placements array
- `src/game/floor1Scenario.ts` - Added `spawnNpcFromPlacement()`, refactored initialization

**Total Lines Changed**: ~120 lines (60 new, 30 modified, 30 restructured)

---

## Conclusion

Phase 4 is now complete. NPC spawning is fully data-driven, extensible, and backward-compatible. Combined with Phase 2 (enemy packs) and Phase 3 (floor manifest), the floor configuration system now has:

- ✅ Data-driven enemy spawning
- ✅ Unified floor configuration manifest
- ✅ Data-driven NPC placement
- 🔲 Multi-floor progression (Phase 5 - ready to implement)

**Status**: Ready for Phase 5 or ready to merge as-is for incremental delivery

**Branch State**: Clean, all tests passing (except pre-existing Azure failure), ready for review or continued development
