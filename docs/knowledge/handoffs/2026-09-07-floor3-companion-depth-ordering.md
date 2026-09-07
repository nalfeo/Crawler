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

Adjusted the shared prop depth buckets so background floor dressing sits below the entity plane instead of covering companions in Floor 3, while keeping foreground occluders on the entity plane when intended. Observed in deterministic render-depth regression coverage: before, `PROP_DEPTH` used positive values above `ENTITY_DEPTH`; after, the values sit below the entity plane and the companion-depth test passes.

## Key Decisions Made

- `PROP_DEPTH` is a shared scene-depth contract, not a set-piece-only value; background dressing must stay below `ENTITY_DEPTH` to avoid burying companions.
- The foreground occluder band remains available at `front: 0` so authored props can still read as covering actors without reintroducing the background bug.

## What's Next / Blockers

None.

## Retrospective

### Lessons Learned

The root cause was a single shared constant, not a Floor 3-only scene edit: the background prop band was numerically above the entity plane, which made companions render under walkable terrain and floor dressing in the real floor scene.

### Mistakes Made

None significant.

### Opportunities for Future Improvement

Add a scene-specific visual regression if a future Floor 3 art pass changes the prop stack again; this would codify the companion-over-background issue into a stronger end-to-end guard.
