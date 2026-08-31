# Handoff: male player neutral direction candidates

**Date:** 2026-08-20  
**Mode:** local Azure generation  
**Apple estimate / actual:** 1🍎 / 1🍎 (art-only; no code, wiring, atlas, or review ledger)

## Systems touched

- `briefs/characters/player-male-*-neutral.yaml`
- `briefs/characters/seeds/player-male-*-skeleton.{svg,png}`
- Local-only candidate runs under `generated/runs/`

## Canon and source of truth

The player remains the televised dungeon contestant described by
`docs/knowledge/game-design/game-design-document.md` and the lore bible's
official source register. The approved neutral-front rig at
`public/assets/generated/player-male-neutral-front-var-0.png` was used as the
first seed for every request. No canon contradiction was found.

This follows `player-walk-8-direction-process.md`: south/front is the frozen
neutral rig; the existing south-east proof was left untouched; no four-frame
south baseline, gait, or combined atlas was used.

## Generated and visually accepted candidates

Each request used a distinct 256×256 raster skeleton guide as its second seed,
was a normal 1×1 character brief, and ran with `judge.enabled: true` and
`maxVariants: 1`. Each candidate below passed all eight deterministic sensors
and received 5/5 on all VLM axes. The images were reviewed inline at game-scale
intent against the neutral rig and their guide.

| Direction  | Candidate                                                                                     | Verdict                            | Later gait / packing readiness |
| ---------- | --------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------ |
| east       | `generated/runs/player-male-east-neutral/2026-08-21T00-36-22-61244985/processed/00.png`       | Clean; profile points screen-right | Ready once durably approved    |
| north-east | `generated/runs/player-male-north-east-neutral/2026-08-21T00-37-35-b866471b/processed/00.png` | Clean; back-right three-quarter    | Ready once durably approved    |
| north      | `generated/runs/player-male-north-neutral/2026-08-21T00-38-34-8301c438/processed/00.png`      | Clean; full rear view              | Ready once durably approved    |
| north-west | `generated/runs/player-male-north-west-neutral/2026-08-21T00-46-20-40901f48/processed/00.png` | Clean; back-left three-quarter     | Ready once durably approved    |
| west       | `generated/runs/player-male-west-neutral/2026-08-21T00-40-38-90451ee2/processed/00.png`       | Clean; profile points screen-left  | Ready once durably approved    |
| south-west | `generated/runs/player-male-south-west-neutral/2026-08-21T00-31-25-dad29a02/processed/00.png` | Clean; front-left three-quarter    | Ready once durably approved    |

Rejected intermediate runs were retained only in `generated/runs/`: the first
east/west attempts mirrored the requested screen direction, the first
northeast/northwest attempts did not read rearward enough, and the first north
attempt failed `interior-transparency-holes` (1,302 enclosed transparent
pixels). No gate was changed.

## Approval / queue blocker

`sprites:approve` was tried once for the first east attempt before visual
review completed. It was immediately unapproved after the candidate was rejected.
That approval's queue commit failed, so no requested direction asset is approved,
queued, committed, or wired.

The queue primitive could not merge `assets/queue` with current `main`, reporting
many existing Welcome Room modify/delete and rename/delete conflicts. Do not
manually resolve those unrelated conflicts from this direction-pose worktree.
After the queue branch is repaired, approve the six paths above with
`npm run sprites:approve -- <runDir> --variant 0`; verify the queue push, then
perform the later gait and atlas stage in the documented direction order.

## Observation

Candidate sheets were visually inspected inline. No in-game observation was
claimed: none of these candidates was durably approved or wired, and this task
explicitly did not create a combined animation atlas.
