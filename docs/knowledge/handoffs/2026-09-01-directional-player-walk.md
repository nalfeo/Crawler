# Male player eight-direction neutral and walk art

**Date:** 2026-09-01
**Persona:** Graphics Designer / Asset Forge
**Apples:** 4🍎 estimated / 4🍎 actual

## Systems touched

sprite-pipeline, sprite-workflow

## Outcome

Completed the male player's full eight-direction neutral set and one runtime
walk atlas using `crawler-male-south-neutral-var-8` as the immutable identity
baseline. Generation ran in local Azure mode; no asset-request issues, GitHub
asset workflows, asset PRs, or legacy check-in commands were used.

Seven missing directions were each generated as genuine 12-candidate sheets,
reviewed at raw-sheet and processed game scale, and approved individually
through the durable `assets/queue` path. South was reused byte-for-byte from
mainline commit `5dbd718f388931af17bc3c1ed6bd278339e1faa0`.

| Direction | Accepted run                            | Variant | Original PNG SHA-256                                               | Queue commit                               |
| --------- | --------------------------------------- | ------: | ------------------------------------------------------------------ | ------------------------------------------ |
| N         | `2026-09-01T03-57-52-850add11`          |       0 | `1bb664d5da1e3c4ee4f77ff2541c3c6c7a24f0e1feec063b538f97f9edec894b` | `6f4785bb5bf60433d0214c74c52363496857022e` |
| NE        | `2026-09-01T04-58-04-65df1199`          |       0 | `4a0a7324e76d55d056bbe871c87ae90ff09995f1b261a7e2542b647f0474ab43` | `04b86c803eb7635a5448b730e75daec954e6ce58` |
| E         | `2026-09-01T05-05-31-b37e280e`          |       0 | `4061081bf60ceb4f245519e557c82898b870b457852ab85c82703df63a83a058` | `d08561c96edc6ae9a6660b60d959aa87966ee316` |
| SE        | `2026-09-01T05-17-05-0415a115`          |       0 | `c21a53c5b2f023207adfccae56b1d9f71e279aba4e347eead2ace7565a3284f9` | `13ac9cc5850d64fe64979c0fbb57b55606cc110f` |
| S         | `external-2026-08-27T06-29-54-7511eaf0` |       8 | `0bcf170a13c8b2febeec3c04dd21f7db99813d6933fbff705351fd7894e2d93b` | `5dbd718f388931af17bc3c1ed6bd278339e1faa0` |
| SW        | `2026-09-01T05-05-31-5bb9c83c`          |       3 | `4f9e1bec251ea3f36e8f5cde7e6938c2d548489a6790ff55988f353a45223c2f` | `ccf35edc8e5e85af35894a34ba4bb74aec58040b` |
| W         | `2026-09-01T04-12-28-61faa0d0`          |       8 | `97387af24ddfe5bc8f2f9c9ea373533a64b0576cae1021abe47b39f384e066b9` | `5e045823b65078292ead503debada53e50aec747` |
| NW        | `2026-09-01T05-25-22-0b6e052a`          |       2 | `754fbe8e56a2076e01071c0b27c2c0cef27e3bedc9a160cfc1d122226f83c8c2` | `43f75cef9164a7f653fd3656eb78d9783a24d04f` |

## Walk atlas

Generated walk sheets were rejected because their frames drifted in identity.
The accepted neutral anchors instead feed a deterministic composer that
normalizes visible height and floor line, then creates four frames per direction:
neutral, upward bob with rightward upper-body sway, neutral, and upward bob with
leftward sway.

- Run: `generated/runs/player-walk-cycle-male/directional-v8-accepted-2026-09-01`
- Layout: 4 columns × 8 rows, 32 frames, 256×390 pixels per frame
- Direction order: N, NE, E, SE, S, SW, W, NW
- Atlas SHA-256: `7b405d1b8c76a84c9ad02e7dda43095c8c3d40fe99a88afc792e061da91afb2b`
- Latest approval queue commit: `458799f95c7333e2032b9b6fd7dff54dec498cd3`
- Queue metadata now records frame-local opaque bounds on a 256×390 canvas

An accidental early `--variant 0` approval created
`player-walk-cycle-male-var-0`. It was removed with a surgical CAS-protected
queue maintenance commit, `7f439c68d6c26947776d1e0f8bf164d476bb112e`,
without discarding newer queue work.

## Rejected generation

No direction remains missing. Rejected runs were retained under
`generated/runs/` for provenance:

- N: `2026-09-01T00-20-35-71b5bac7`
- NE: `2026-09-01T04-02-25-fd6e97d3`,
  `2026-09-01T04-28-57-f3062ca7`, `2026-09-01T04-46-55-ab652e90`
- E: `2026-09-01T04-04-55-e50f0fa4`, `2026-09-01T04-31-52-4be2c029`
- SE: `2026-08-31T23-59-48-1c517056`,
  `2026-09-01T00-03-01-e01861a1`, `2026-09-01T00-07-05-bfb42f6a`,
  `2026-09-01T00-10-42-a0a4380e`, `2026-09-01T04-07-43-df05814d`,
  `2026-09-01T04-34-40-3bdda5b8`, `2026-09-01T05-05-31-0415a115`
- SW: `2026-09-01T04-10-15-b2398ba3`, `2026-09-01T04-37-14-db279119`
- NW: `2026-09-01T04-15-12-1ee79726`,
  `2026-09-01T04-41-07-99123808`, `2026-09-01T05-05-31-84ce8e6e`,
  `2026-09-01T05-17-06-84ce8e6e`

Sheets were rejected for incomplete candidate counts, malformed slicing,
wrong-facing poses, enclosed-transparency failures, or identity/scale drift.
West's first ranked candidates faced the wrong way; variant 8 was selected only
after reviewing the complete sheet.

## Durable source-sheet recovery

The original accepted winners remained durable, but the direct generation path
had stored the seven source review sheets only under the generating worktree.
The sheets were regenerated without replacing any accepted asset, using the
Azure-backed sidecar route so each raw sheet, brief, prompt/reference metadata,
slice map, and summary remains available after this session.

| Direction | Durable recovery run           | Raw sheet SHA-256                                                  |
| --------- | ------------------------------ | ------------------------------------------------------------------ |
| N         | `2026-09-01T15-39-24-850add11` | `b7e9a756e39d77f885e8c41905c607704f6e4aab144ec571faec214b35669097` |
| NE        | `2026-09-01T15-41-42-65df1199` | `7242f9ad910a8f649ecc4d2d7446d6d72c375a46f0c68127314e24bb44e76f9e` |
| E         | `2026-09-01T15-43-03-b37e280e` | `cdb3fe36ca7da9443a0ad05a19c9b15559aeff951aaf5f86dd53b7960e956f8c` |
| SE        | `2026-09-01T15-44-22-0415a115` | `2fd70428de896f16d38591b2d12dbbb6ef8de44a67fbe9d909512d63f0772420` |
| SW        | `2026-09-01T15-46-14-5bb9c83c` | `819150ca61515bcdfb96297d91999c56b27021b75e0c1771959981a210fbbb68` |
| W         | `2026-09-01T15-47-51-61faa0d0` | `6e3b223031fdf877eef17ddf30ae10b5fa0469a2f3bf5dc2c5ec3a7974b27210` |
| NW        | `2026-09-01T16-36-29-dbbae735` | `6ab88c046c727ed813468d269657d03ab86325b593ef0cccb41b93a1f582479f` |

South's original source run remains
`crawler-male-south-neutral-v2/2026-08-27T06-29-54-7511eaf0`. All eight sheets
were downloaded into the session Screenshot Viewer gallery under
`directional-neutral-sheets`. N, NE, and E re-sliced to 12 candidates. W and the
final NW retry visibly contain 12 candidates. SE and SW raw sheets remain the
authority because internal transparent seams confused the content-aware slicer;
no malformed auto-slice was approved.

The durability root cause was fixed separately in ready-for-review PR #4036:
direct generation now mirrors run data to Azure, persists exact brief and prompt
provenance before provider execution, and fails approval closed if durable run
artifacts cannot be verified.

## Parent workflow inheritance

This child branch was rebased onto parent PR #3234 at `85b29f953`. The parent
worktree's still-uncommitted workflow behavior was then ported surgically:

- raw-only and processed runs expose **Force reprocess from raw**;
- forced recovery resets stale postprocess customization, permits intentional
  grid replacement, and binds to the run displayed in the Sprites tab;
- processed variants expose an explicit displayed-run judge action;
- variant thumbnails retain their natural aspect ratio instead of being forced
  into 96×96 squares.

The live workflow canvas showed the force control for a raw-only run and measured
an East 256×390 candidate at 105×160 with `object-fit: contain`.

## Runtime wiring and observation

`player-walk-cycle-male` remains the male player mapping. The generated manifest
now carries exact direction ranges `0–3`, `4–7`, through `28–31`.
`PhaserBridge` selects a direction from velocity, preserves the last facing at
rest, and snaps idle to that direction's clip-start frame.

The real game was run at `http://127.0.0.1:4190/` with male gender selected.
Eight movement and idle captures under
`files/directional-player-real-game-*.png` showed distinct facings through
`MainGameScene` and `PhaserBridge`; every stop returned to its matching neutral
anchor. The existing scale `0.1796875` rendered the approximately 352-pixel
opaque figure at about 63 screen pixels and remained readable.

## Pipeline and review fixes

- Added paired rectangular generation dimensions so Azure and local providers
  can request 1024×1536 or 1536×1024 sheets.
- Added deterministic 4×8 atlas packing and composed source-asset provenance.
- Wrapped velocity octant rounding back into `[0, 7]`.
- Prevented non-looping directional clips from replaying unless direction changes.
- Enforced in-bounds, non-overlapping, complete directional clip coverage in the
  runtime manifest schema.
- Recorded frame-local rather than whole-atlas opaque bounds for animations.
- Inherited the exact remote-main queue CAS fix at commit `bd9dc90cf`.
- Kept displayed-run force actions run-scoped: they bypass workflow-item
  mutation, call the sidecar with explicit brief/run IDs, and invalidate only
  the selected run view.

## Verification

- Immutable South hash and final atlas hash were rechecked after composition.
- Targeted directional/pipeline coverage: 131 tests passed.
- Queue-repair coverage: 5 tests passed.
- Previously timed-out batch/sidecar integrations: 15 tests passed serially.
- Changed sprite coverage reached 1,340 passing tests before three
  single-worker Git integration timeouts; the exact three files then passed
  56/56 without the artificial serial bottleneck.
- Runtime mapping regression: 26 tests passed.
- Physics, AI parity, registry, asset-integrity, and allowlist guards passed.
- Real-game observation covered all eight movement and idle directions.
- Task-scoped code review and adjudicated multi-model review are clean.
- Parent workflow inheritance: 320 extension tests and 15 sidecar re-run
  integration tests passed; `typecheck` and `verify:fast` passed.

Review ledger:
`docs/knowledge/review-ledgers/2026-08-31-directional-player-walk.review-ledger.json`

## Publication state

- Mode: local Azure
- Issue waves: 0
- Asset issues opened: 0
- GitHub workflow failures: 0
- Approved neutral assets: 8, including immutable South
- Approved walk atlases: 1
- Durable queue tip after final atlas metadata update:
  `458799f95c7333e2032b9b6fd7dff54dec498cd3`
- Remaining directional placeholders: 0

## Blockers

None.
