# Session Handoff: Wire approved stairs sprite into the floor-exit objective marker

## Date

2026-08-22

## Persona

Producer

## Systems touched

hud-ux, quests

## Apples

2🍎 exact

## What Was Done

Closed #3244: the Floor 1 `▼ STAIRS` / Floor 2 `▼ EXIT` objective marker in
`MainGameScene` previously rendered as a plain filled `Arc` (a flat circle).
Added `src/engine/sprites/stairs-visuals.ts` (pure fit-resolution helper +
`STAIRS_TEXTURE_KEY` constant pointing at the already-approved-but-unused
`the-stairs-var-0` generated sprite) following the existing
`door-visuals.ts` generated-art wiring pattern. `MainGameScene` gained a new
shared `renderStaircaseMarker()` method (replacing duplicated Floor 1/Floor 2
marker code) that stamps the generated art (tinted amber/green for
locked/unlocked) over the marker footprint, falling back to the plain circle
if the art isn't loaded, with the circle's stroke ring kept for color
affordance either way.

Observed in the real booted scene (not just a lab in isolation): added
`getStaircaseMarkerRenderInfo()` to `MainGameScene`, wired it through
`main-scene-probe-lab` and the e2e probe helper, and added
`tests/e2e/staircase-marker.test.ts`, which boots the actual
`MainGameScene` via the lab's `primeFloor1StairTransition()` and asserts
`usesGeneratedArt: true` once the Floor 1 stairs are unlocked — before this
change that flag path didn't exist and the marker was circle-only.

## Key Decisions Made

- Reused the existing `the-stairs` approved sprite brief (4 variants) instead
  of commissioning new art; picked `var-0` as the cleanest of the four
  (var-1 has a render artifact, var-3 has stray skeleton bones) and used a
  fixed texture key, mirroring `door-visuals.ts`'s pattern rather than
  randomizing per-marker.
- Treated the stairs decal as `anchorBase: false, floorPlane: true` in
  `resolveOpaqueFit` (centered + contain-fit on both axes), since it's a
  floor-plane tile decal, not a standing object like a door.
- Kept the circle's stroke ring even when the sprite renders (only the fill
  drops to 0 alpha) so the locked (amber) / unlocked (green) color
  affordance survives without a solid circle dominating the marker.
- Cached the generated-sprite-registry opaque-bounds lookup in a new
  `staircaseBoundsCache` field (code-review finding) since the registry
  entry never changes after boot and `renderStaircaseMarker()` runs every
  frame from `updateObjectiveMarkers()`.
- Raised the sprite's Phaser depth above the circle's (21 vs 20) so it always
  renders on top regardless of the circle's fill-alpha state (code-review
  finding — previously the sprite depended on the fill alpha staying at 0).

## What's Next / Blockers

None — this is a self-contained rendering-wiring fix. A future session could
consider randomizing across the 4 approved `the-stairs` variants per-floor
seed if visual variety is desired, but that wasn't requested by the issue.

## Retrospective

### Lessons Learned

- `public/assets/generated/manifest.json` is a gitignored build artifact
  composed from per-asset shard JSON files
  (`public/assets/generated/entries/*.json`) at build/dev time — wiring an
  already-approved sprite requires zero manifest edits, just referencing the
  right texture key.
- The Playwright MCP browser tool (`playwright-browser_*`) failed in this
  sandbox with an OAuth/transport error unrelated to the code
  (`MCPOAuthBrowserRequiredError`); the working alternative is a direct
  Playwright-via-Node e2e test (`npx vitest run tests/e2e/... --project=e2e`),
  which needed `npx playwright install chromium --with-deps` once per
  session/container since the browser binary isn't preinstalled.
- `main-scene-probe-lab` already exposes turnkey helpers like
  `primeFloor1StairTransition()` for arranging the live world at specific
  objective states — check there before building a new observe seam from
  scratch.

### Mistakes Made

- Initially considered `tile-boss-staircase-floor-var-10.png` as a candidate
  asset based on its filename, but visual inspection showed it actually
  renders a monster/wolf sprite, not stairs — always visually confirm
  generated art before wiring it in, filenames can be wrong/stale.

### Opportunities for Future Improvement

- No dedicated "rendering"/"engine-scenes" system slug exists in
  `docs/systems/README.md`; this handoff used `hud-ux` + `quests` as the
  closest fit. A future docs pass could consider whether marker/decal
  rendering changes need a clearer home.
