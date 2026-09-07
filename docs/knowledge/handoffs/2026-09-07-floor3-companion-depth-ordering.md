# Session Handoff: Floor 3 companion depth ordering

## Date

2026-09-07

## Persona

Producer

## Systems touched

mapgen, vfx

## Apples

2🍎 exact

## What Was Done

Adjusted the shared prop depth buckets so background floor dressing sits below the entity plane instead of covering companions in Floor 3, while keeping foreground occluders strictly above the entity plane so occlusion never depends on Phaser's stable sort tie-breaks. Added deterministic render-depth unit coverage and a real `MainGameScene` Floor 3 e2e probe that resolves the starter Companion, overlaps it with spawned background/foreground props, captures the rendered canvas, and asserts the actual Phaser display depths satisfy `background < companion < foreground < player`.

## Key Decisions Made

- `PROP_DEPTH` is a shared scene-depth contract, not a set-piece-only value; background dressing must stay below `ENTITY_DEPTH` to avoid burying companions.
- The foreground occluder band remains available at `front: 1`, strictly above `ENTITY_DEPTH` and below `PLAYER_DEPTH`, so authored props can cover actors without making ordering insertion-dependent.

## What's Next / Blockers

None.

## Retrospective

### Lessons Learned

The root cause was a single shared constant, not a Floor 3-only scene edit: the background prop band was numerically above the entity plane, which made companions render under walkable terrain and floor dressing in the real floor scene.

### Mistakes Made

None significant.

### Opportunities for Future Improvement

The real-scene Floor 3 e2e now covers the companion/background overlap; future art passes should extend that probe rather than adding constants-only assertions.
