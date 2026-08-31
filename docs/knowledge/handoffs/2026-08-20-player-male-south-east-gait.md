# Handoff: male south-east directional gait

**Date:** 2026-08-20  
**Mode:** local Azure sidecar  
**Apples:** 2🍎 estimated / 2🍎 actual (task-specific art-pipeline prompt
contract plus art-only briefs/seeds; no engine, viewer, wiring, queue, or
approval work)

## Systems touched

- `briefs/characters/player-male-south-east-gait.yaml`
- `briefs/characters/seeds/player-male-south-east-neutral.png`
- `briefs/characters/seeds/player-male-south-east-gait-skeleton.{svg,png}`
- `scripts/sprites/brief-schema.ts`
- `scripts/sprites/build-prompt.ts`

## Canon and input contract

The character remains the televised-dungeon contestant in
`docs/knowledge/game-design/game-design-document.md`, cited by the lore bible's
world-premise register. No canon contradiction was found.

The accepted south-east neutral candidate was staged as
`briefs/characters/seeds/player-male-south-east-neutral.png` from
`generated/runs/player-male-south-east-neutral/2026-08-21T00-11-30-8c963fe9/processed/00.png`.
It had all 8 deterministic sensors and a 5/5 VLM review. The new 1024×1024
gait guide describes row-major contact/passing/opposite-contact/opposite-passing
poses on a shared floor line.

`seedFrames` originally treated every attached image as an identity frame. That
made the gait skeleton compete with the accepted rig. The task-specific process
contract now supports `role: identity | pose-guide`; the prompt locks visual
identity only from identity seeds and uses pose guides only for geometry/timing.
It also removes the incorrect universal `side-view` walk-cycle statement so a
south-east three-quarter gait can retain its requested camera direction.

## Generated runs and verdicts

No candidate was approved, packed, queued, wired, or observed in game.

| Run                                                                       | Deterministic sensors               | VLM judge                                             | Verdict                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated/runs/player-male-south-east-gait/2026-08-21T05-12-51-454d9aff` | 4/4 frames: 8/8                     | all 4 rejected, minimum 1/5                           | Reject: cropped, near-static upper-body figures; no gait                                                                                                                     |
| `generated/runs/player-male-south-east-gait/2026-08-21T05-18-17-67c8c852` | 4/16 slices: 8/8; remaining 12: 4/8 | all 4 judged candidates rejected, maximum minimum 2/5 | Reject: the source sheet visibly has 2×2 frames, but content-aware slicing persisted it as 2×8/16 slices; the full figures remain near-static and do not meet the gait brief |

The second run proves the identity-vs-pose-guide prompt correction was applied
(`promptHash: ed873394`), but not that the gait is correct. The `2×8` persisted
grid is a hard blocker to a four-frame sequence: packing would be invalid even
if a candidate later passed, because the persisted frame count and pivots cannot
be established as uniform. Do not loosen the slicer, sensor, or VLM threshold.

## Required next step

Escalate the frame-sequence slicing mismatch and the non-converging gait output
to a human before a third paid generation round. Provide both posted sheet
images, the run summaries, and judge rationales. If the slicer can be made to
preserve the declared 2×2 sequence grid without weakening guards, regenerate
the south-east brief, require all four frames to pass sensors and VLM review,
then inspect at game scale before considering packing.

## Verification

- `npx tsx` prompt-contract probe — passed.
- `npm run typecheck` — passed.
- `npm run verify:fast` — pending at handoff.
