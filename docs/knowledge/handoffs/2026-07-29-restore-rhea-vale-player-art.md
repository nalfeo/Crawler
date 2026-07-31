# Session Handoff: Restore Rhea Vale player art (Kenney-knight regression)

## Date

2026-07-29

## Persona

Producer → Sprite/Engine wiring

## Systems touched

sprite-pipeline

## Apples

2🍎 exact

## What Was Done

The player rendered as the Kenney knight instead of Rhea Vale in the live game.

Root cause: PR #2296 (Slice A, player walk animation) repointed the `player`
render kind in `src/shared/data/entity-sprite-mappings.json` at
`player-walk-placeholder-v1` / `player-walk-placeholder-v1-var-0`, but **no
manifest shard and no PNG with that key were ever committed**. The only art the
PR shipped was `public/assets/generated/rhea-vale-v1-var-0-walk.png` (192×64, a
3-frame Rhea walk strip). With no matching manifest entry,
`resolveGeneratedTexture` fell through every branch and returned `null`, so the
bridge silently used the Kenney `player` frame. Every test in that PR built a
synthetic registry, so nothing exercised the real mapping-vs-manifest link.

Fix:

- Added the missing manifest shard
  `public/assets/generated/entries/rhea-vale-v1-var-0-walk.json`
  (`briefId: rhea-vale-v1-walk`, `type: character`, real SHA-256 content hash)
  carrying the `animation` descriptor `{64×64, 3 frames, 8fps, loop}` so
  `preloadGeneratedSprites` queues it via `loader.spritesheet`, not
  `loader.image`.
- Repointed the `player` render kind at `rhea-vale-v1-walk` /
  `rhea-vale-v1-var-0-walk` (scale unchanged at 0.72).
- Added `tests/unit/entity-sprite-mapping-art-wiring.test.ts`: for **every**
  render kind carrying a `generated` block, asserts the `briefId` has approved
  shipped variants and the `pinnedTextureKey` is a real shard key, plus a
  player-specific pin on the Rhea art + animation descriptor.
- Retargeted the two tests that hard-coded the dead placeholder key
  (`phaser-bridge.test.ts`, `player-walk-animation.test.ts`).

Observed in `npm run dev` — before: the player was the white Kenney knight (see
the reported screenshot); after: Rhea Vale renders as a single 64px frame and
the pose visibly changes between the idle screenshot and a mid-walk screenshot
while moving right. `npm run sprites:check-manifest`, `npm run check:sort-assets`
and `npm run verify:fast` all pass.

## Key Decisions Made

- **New brief id `rhea-vale-v1-walk` rather than reusing `rhea-vale-v1`.**
  Adding the walk strip as a second variant under the existing brief would give
  `pickGeneratedVariant` two candidates with `variantIndex: 0`, letting the
  seeded pick hand a 192×64 strip to consumers that expect a single frame (e.g.
  weapon-anchor resolution). A distinct brief keeps the static entry
  authoritative for those paths.
- **No `opaqueBounds` on the walk shard.** Bounds are canvas-relative and only
  consumed by the set-piece prop fit path; authoring 192-wide bounds for a
  64-wide frame would be a lie waiting to be believed.
- **The new guard is generic, not player-only.** The same class of bug (mapping
  pointing at art that was never shipped) can hit any entity, so the test walks
  every `generated` block.

## What's Next / Blockers

- Slice B shipped a separate generated `player-walk-cycle` (4-frame, 256×64) of
  a different character. It is currently unwired. Decide whether it replaces
  Rhea Vale as the player or is retired; today it is inert shipped art.
- No blockers.

## Retrospective

### Lessons Learned

- A `generated` block in `entity-sprite-mappings.json` fails **silently**: every
  resolution branch returns `null` and the renderer quietly falls back to Kenney.
  There is no warning log on that path, so a mis-wired mapping looks like "the
  art just didn't change".
- The aggregate `manifest.json` is gitignored and composed from
  `public/assets/generated/entries/*.json` at build time, so "is this texture key
  real?" must be answered against the shard directory
  (`tests/helpers/generated-manifest.ts` → `loadShippedManifest()`).
- `npx vitest run --project unit <files>` is the fast targeted loop here; the
  three affected files run in <3s.

### Mistakes Made

- Initially considered filing the walk strip as a second variant of
  `rhea-vale-v1`; caught before writing it by reading `pickGeneratedVariant`,
  which uses `SeededRandom.pick` once a brief has >1 variant. Early signal: any
  time you add a shard, check whether its `briefId` already has variants and
  what consumers do with `variants()`.
- Wrote the guard test before proving it fails on the broken state. Corrected by
  temporarily restoring the bad mapping and re-running (3 failures), then
  reverting — do that inversion check first, otherwise a "guard" can be green
  for the wrong reason.

### Opportunities for Future Improvement

- `resolveGeneratedTexture` should `logger.warn` once per render kind when a
  `generated` block resolves to nothing. That single log would have made this a
  five-minute diagnosis instead of a git-archaeology session.
- Consider promoting the new mapping/manifest integrity test into a
  `npm run check:*` script so it runs in the same CI job as
  `sprites:check-manifest`, where art-wiring invariants already live.
- The sprite approve pipeline could refuse to leave a `pinnedTextureKey` in
  `entity-sprite-mappings.json` that has no shard, closing the loop at authoring
  time rather than at review time.
