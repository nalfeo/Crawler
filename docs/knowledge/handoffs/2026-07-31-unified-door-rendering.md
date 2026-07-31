# 2026-07-31 — Unified door rendering: one geometry rule, art as a per-tileset lookup

Retired Crawler's second door renderer. Door geometry is now global and identical for every
art source; art is a lookup that carries **no** geometry.

## Systems touched

terrain-packs, rendering, sprite-pipeline, labs

## Apples

**4🍎** (estimated 4, actual 4). Ledger:
`docs/knowledge/review-ledgers/2026-07-31-unified-door-rendering.review-ledger.json`

## The defect (measured, not inferred)

`resolveDoorRenderMode` returned five kinds and `MainGameScene` gave each its **own scale
rule**, so door SIZE was decided by which asset happened to exist:

| mode        | scale rule                        | result                             |
| ----------- | --------------------------------- | ---------------------------------- |
| `pack`      | `tileSize / TERRAIN_PACK_CELL_PX` | 4 ft × 4 ft, full cell, no fitting |
| `generated` | contain-fit into 4 ft × 6.5 ft    | aspect-correct, ≤ 1 cell wide      |
| `kenney-*`  | `tileSize / 16`                   | 4 ft × 4 ft                        |
| `color`     | raw `fillRect`                    | 1 cell                             |

The two real sources also disagreed about **projection**: pack doors were top-down hatches,
generated doors side-on elevations.

Evidence gathered in the running artifact (`lab.html?lab=ai-runner&scenario=floor1-default`,
seed 42):

- `getDoorRenderSummary()` → **84 closed pack / 0 generated**. The pack path won
  unconditionally, so the "real" renderer never ran on Floor 1.
- All four pack door PNGs were **64×64 with zero transparent pixels** → exactly
  4.00 ft × 4.00 ft against a 5.75 ft player.
- Across four packs there were only **two distinct door files**, visually
  indistinguishable. The pack path bought **no biome differentiation** while overriding the
  real renderer — the whole justification for its existence was not being cashed in.

## What changed

1. **One fit.** `resolveGeneratedDoorContainFit` → `resolveDoorContainFit`. Every art source
   routes through it: contain-fit the opaque box into `tileSize` × `DOOR_TARGET_HEIGHT_FT`,
   bottom-anchored. **No draw branch computes its own scale.**
2. **Art selection carries no geometry.** `resolveDoorRenderMode` picks a texture key by
   precedence only — exact-orientation generated → cross-orientation generated → Kenney →
   colour — and reports `orientationMatch: 'exact' | 'cross'`. The `pack` kind is deleted.
3. **Pack door art retired.** `doorSet` removed from `terrainPackDefSchema` (the schema is
   `.strict()`, so a stale `doorSet` now fails loudly rather than being ignored) and from
   all four manifests; 16 rendered door PNGs + 2 `door-material.png` build inputs deleted;
   `renderDoorTile` and its palette removed from `procedural-surfaces.ts`; door emission
   removed from `compose-pack.ts`, `cli.ts`, `build-industrial-cave.ts`,
   `build-caeles-fixture.ts`; `validate.ts` no longer validates door images;
   `terrain-pack-visuals.ts` no longer preloads them.
4. **Per-tileset door art remains the intended extension point** — it re-enters through the
   _same_ fit rule. Documented in `DOOR_ART_CONTRACT_NOTE`, deliberately **not** left as a
   dead schema field.

## The blocking finding the adversarial plan review caught

Retiring pack art looked free. It was not.

`tests/e2e/floor2-pack-door-overlay.test.ts` documented that Floor 2's `cave_system` stamps
**every** room connector as `DOOR_OPEN` — Floor 2 is entirely open doors, roughly half of
them E/W. At the time, `tile-door-open-side-v1-var-0` **did not exist**, so retiring pack
art would have silently regressed every E/W open door on Floor 2 to face-on projection.

The user approved retirement **without being told that gap existed**. Per repo rule #11 that
could not be silently traded away, so the gap was **closed rather than accepted**: a
delegated Asset Forge session generated the missing side-on OPEN leaf (7/7 sensors, judge
passed, opaque bounds 69×114 / aspect 0.605 — sitting between closed side-on 0.474 and open
face-on 0.789). See `2026-07-31-side-on-open-door-sprite.md`.

All four wired keys now name real approved art, so `crossOrientationCount` must be **0**.

## Observe before done (real artifact, not a lab-only claim)

`npm run lab` → `lab.html?lab=ai-runner`, ambient/discovered light forced to 1.0 so geometry
is not hidden by FOV.

| scenario                           | before                    | after                                                                                                       |
| ---------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `floor1-default` (seed 42), closed | 84 **pack** / 0 generated | `closedGeneratedCount: 84`, Kenney 0, colour 0, **`crossOrientationCount: 0`**, `renderableClosedCount: 84` |
| `terrain-wall-junctions`, open     | —                         | `openGeneratedCount: 5`, Kenney 0, colour 0, **`crossOrientationCount: 0`**                                 |

`hasTexture` true for all four keys. Visually, doors changed from flat 4×4 ft top-down
hatches to one-cell-wide ~6.5 ft portrait side-on elevations seated in the doorway.
Captures: `files/doors-before-full.png`, `files/doors-after-full.png`,
`files/doors-after-junctions.png`.

The open-door scenario is the load-bearing observation: it exercises the **new** side-on
OPEN art, which is exactly the case that would have regressed to `cross`.

> The captures above are **pre-orientation-fix** (see next section). The final,
> correct state is `files/doors-orientation-fixed.png`.

## The second defect: orientation was inverted (found by multi-model review)

The multi-model code review found a **HIGH** bug that the plan review, the implementation and
every existing gate missed: `resolveDoorOrientationFromFlanks` returned the **passage** axis,
while `DoorOrientation` and the `door-visuals` key table are indexed by the **wall run**. So
every unambiguous doorway drew its _sibling's_ art — narrow side-on leaves in face-on N/S
openings and wide face-on leaves in E/W ones.

**Why it was latent.** `horizontalDoorway = isWall(x-1,y) && isWall(x+1,y)` means walls to the
left _and_ right, i.e. the wall run is left↔right and the door is viewed **face-on**. The
helper returned `'vertical'` for that case, matching the convention of the now-deleted
top-down `renderDoorTile` hatch, where "vertical" described the passage a top-down door
occupies. That was self-consistent while pack art won selection unconditionally, because the
orientation-sensitive generated keys were never reached on any shipped floor. **Retiring the
pack path is what made it live** — this change did not introduce the bug, it de-latched it.

**Why `crossOrientationCount` cannot see it.** A mislabelled orientation still resolves its own
_nominal_ exact key, so the counter reads `0` in both the correct and inverted worlds. The
telemetry that the adversarial plan review added specifically to catch orientation problems is
structurally blind to this one. Only the **composition** — doorway geometry → orientation →
texture key — is falsifiable.

**Fix.** `resolveDoorOrientationFromFlanks` now returns the wall run
(`horizontalDoorway ? 'horizontal' : 'vertical'`). The fix went in the _producer_, not the key
table, because the passage-axis convention belonged to the deleted hatch renderer and has no
remaining consumer; correcting the producer removes the ambiguity instead of relocating it.
There is exactly one production caller (`MainGameScene.ts`).

**New gate.** `tests/unit/door-visuals.test.ts` gains an **end-to-end topology → texture-key**
block that drives real doorway flank geometry through both helpers and asserts the final
resolved key. That is the only test in the suite that can catch this class; unit-testing either
helper alone passes happily under the inversion.

**Re-observed.** `terrain-wall-junctions` re-captured after the fix and the swap confirmed by
eye — compare `files/doors-after-junctions.png` (inverted) against
`files/doors-orientation-fixed.png` (correct).

The other three review findings: a **knip CI-breaker** (`DOOR_ART_CONTRACT_NOTE` exported with
no consumer — a JSDoc `{@link}` is **not** a usage for knip or eslint, so dropping `export` is
not enough; it is now consumed as the assertion message in the block it describes), a
**non-falsifiable Kenney fit guard**, and a dead `'door'` preload union member. Note that
`verify:fast` does **not** run knip — that gap is why a blocking-CI failure nearly shipped
green.

## Tests

Several tests asserted the behaviour being removed. They were **inverted, not deleted** — a
deletion would leave the removal unguarded.

- `tests/e2e/unified-door-overlay.test.ts` — **new**, replaces both
  `generated-door-overlay` and `floor2-pack-door-overlay`. One two-floor gate (Floor 1
  closed, Floor 2 open): generated count == renderable count, zero Kenney/colour, and
  `crossOrientationCount === 0`.
- `tests/unit/main-game-scene-door-wiring.test.ts` — **new**, inverts
  `main-game-scene-door-pack-wiring`. Asserts `resolveDoorPoolVariant`, `packDoorTextureKey`,
  `activeDoorSet`, `case 'pack'` and `TERRAIN_PACK_CELL_PX` are all **absent** from the
  scene. Greps **comment-stripped** source (the retired symbols are deliberately named in
  explanatory comments), with a _guard-the-guard_ non-vacuity test so a broken stripper
  cannot make every `not.toContain` pass trivially.
- `tests/unit/generated-door-art.test.ts` — gains a **projection contract** block:
  transparent side margins, portrait aspect < 0.95, bottom-weighted. This is the durable
  guard: deleting four PNGs fixes today, it does not stop a future tileset from
  reintroducing a full-cell hatch. Also tightened to require **all four** wired keys to name
  real art.

**Non-tautology, verified.** The retired hatch bounds (`64×64` in a `64×64` canvas) fail the
side-margin and portrait properties — 2 of 3. Crucially, feeding those same bounds through
`renderedFt` alone would **not** fail, because a 1:1 box contain-fits to a perfectly legal
4×4 ft. That is precisely why the width/height caps are insufficient on their own and the
projection properties had to be added.

## Gotcha for the next session

**No gate in the sprite pipeline measures viewing angle.** The Asset Forge session found that
a head-on candidate indistinguishable from the face-on door scored 16/16 sensors _and_ 5/5/5/5
from the VLM judge. There is no projection sensor and no aspect sensor, so the eyeball at game
scale is the only defence — and that trap has now caught four sessions. The new
`generated-door-art` projection block closes it for **door** art specifically; a cheap
deterministic `sensors.aspect: { min, max }` over opaque bounds would close it generally.

## Note on PR overlap

The delegated art session also opened art-only PR **#2414** carrying the same two files
(`tile-door-open-side-v1-var-0.png` + its entry JSON). Those files are also committed on this
branch, because the new e2e/unit gates depend on them and the branch must be self-sufficient.
The content is byte-identical, so whichever merges first, the other resolves cleanly.
