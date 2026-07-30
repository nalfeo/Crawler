# Terrain wall-junction inspection scene for the AI-runner lab

## Date

2026-07-29

## Persona

DevOps Engineer (agent tooling / labs)

## Systems touched

devtools, mapgen

## Apples

2🍎 estimated, 2🍎 actual (exact). Tooling/lab-only change; no runtime gameplay
behavior or shipped game data changes, so the tooling ceremony cap applies.

## What Was Done

Follow-up to PR #2330 (`fix(terrain): square dungeon wall corners and flush door
junctions`). That PR fixed two Floor 1 `dungeon` defects — cave-style rounded wall
corners, and walls stopping short of doors — but its observe-before-done evidence
had an honest gap: an in-game screenshot framing a wall/door junction was never
captured, because teleporting to a doorway kept landing outside the terrain
streaming boundary.

The maintainer's feedback was that this class of task should build a **specialized
scene the AI runner lab can jump directly to**, the way the spawner arenas work,
rather than hunting for a seed that happens to contain the geometry under test.
This change does that.

### `terrain-wall-junctions` scenario preset

```
http://localhost:15281/lab.html?lab=ai-runner&scenario=terrain-wall-junctions
```

- 24×20 slice; chamber walls x7–16 / y6–13; player spawned dead centre (11, 10).
- **Five doors** — one on each cardinal wall plus a second north door — so every
  door/wall orientation is on screen at once.
- **`materialSeamX = 12`** splits the chamber into `stone` (→ `floor1-dungeon`,
  **square** corners) and `cave` (→ `floor1-cave`, **rounded** corners), so the two
  corner styles are compared side by side across a seam. This also makes the
  cross-pack boundary-ring compatibility relaxation from ADR 0078 visible rather
  than merely asserted in a test.
- Nine stub tiles produce isolated wall ends, tees and elbows.
- A fully-lit lighting profile (`ambient: 1`, `discoveredLight: 1`,
  `sourceIntensity: 1.2`) is applied for this scenario so fog cannot hide the
  junctions.

Supporting changes:

- New **`?scenario=<id>` URL param** on the ai-runner lab
  (`scenarioPresetIdFromUrl()`). It takes priority over persisted lab state, and
  unknown ids fall through to the existing defaults rather than throwing.
- Extracted the shared world reset out of `configureSpawnerSlice` as
  **`resetSliceWorld(world, playerEid, floorMap)`** and reused it for the new slice.
- `AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS` now exposes `makeTerrainJunctionSliceMap`
  and `TERRAIN_JUNCTION_SLICE`.

### `npm run lab` now prints the real lab URL

Vite's startup banner advertises the server root (`/`), which serves `index.html` —
the **game**, not the lab shell. Copying it lands you on the wrong page, and
"forgot `lab.html`" has now cost multiple sessions (the 2026-07-25 set-piece handoff
logged the identical lesson and it did not stick, because a lesson buried in one
handoff is not a control).

`tools/vite-plugin-lab-url-banner.ts` prints the correct `…/lab.html?lab=<lab-id>`
form once the dev server is actually listening. It is registered only for
`vite --mode lab` and only applies on `serve`. `formatLabUrl` is unit-tested.

## Observation (rule #10)

Loaded `http://localhost:15281/lab.html?lab=ai-runner&scenario=terrain-wall-junctions`
in the real running lab and confirmed via `window.__aiRunnerDebug()` that
`scenarioPreset === 'terrain-wall-junctions'` and the player sits at the authored
tile (world 46, 42 = tile 11.5, 10.5). Screenshotted the lit chamber: **walls run
flush into all five door frames with no notch**, stone-side corners are square,
cave-side corners are rounded, and the material seam is visible down the middle.

This is a lab-only change (`src/labs/**`, `tools/**`, `tests/**`) that adds no
`*System` and alters no runtime pipeline, so the "lab-only validation is
insufficient" rule does not apply — the lab **is** the artifact under change. The
gameplay fix it inspects was separately proven on the real runtime path by the
fail-to-pass test in `tests/unit/terrain-pack-renderer.test.ts` (merged in #2330).

The scene's geometric claims are guarded **deterministically**, not just visually,
in `tests/unit/ai-runner-scenario-presets-wiring.test.ts`:

1. every door tile is flanked by wall on the perpendicular axis;
2. all four wall orientations and both terrain packs are present;
3. the material seam actually crosses a wall run (not only floor);
4. the player spawn is passable and inside the chamber.

`npm run verify:fast` ✅ (typecheck + lint + changed unit tests; 8 tests across the
two touched test files pass).

## Key Decisions Made

- **Authored slice, not a seed.** `configureWorld` stamps an explicit `floorMap`,
  the same mechanism the spawner arenas use. Searching for a seed containing the
  right adjacency is slower and produces no durable artifact.
- **URL param beats persisted state.** A deep link must win over whatever the lab
  last stored in `localStorage`, otherwise the link is not reproducible for someone
  who has used the lab before.
- **Unknown scenario ids fall through** rather than throwing, so a stale bookmark
  degrades to the default scenario instead of a blank page.
- **Fixed the URL papercut structurally.** A repeated human-facing mistake that has
  already been written down once and repeated anyway needs a control, not another
  bullet in a retrospective.

## What's Next / Blockers

- No blockers. PR #2330 is merged; this lands on top of it.
- If more terrain-geometry bug classes appear, extend `TERRAIN_JUNCTION_SLICE`
  rather than adding parallel scenes — the wiring test already enumerates the
  adjacencies it must contain, so additions are self-checking.
- Worth considering: a deterministic e2e pixel probe driven from this exact
  scenario, which would turn the visual check into a CI-enforceable gate for the
  wall/door junction bug class.

## Retrospective

### Lessons Learned

- **A purpose-built scenario preset beats seed hunting.** `scenario-presets.ts`'s
  `configureWorld` hook lets a preset stamp an authored `floorMap` and reposition
  the player. For any "this geometry renders wrong" bug, authoring the geometry
  directly is faster than finding a seed that contains it — and leaves behind a
  permanent, deep-linkable artifact for the next person.
- **The Phaser WebGL canvas cannot be read back.** `preserveDrawingBuffer` is false,
  so `drawImage`-ing `#lab-canvas` into an overlay canvas to crop or zoom returns
  solid black. To zoom, shrink the browser viewport instead (the camera follows the
  player, so a smaller viewport yields a tighter crop); to remove fog, call
  `__floor1Debug.lighting.setConfig({ ambient: 1, discoveredLight: 1 })`.
- **Labs are served from `lab.html`.** `/?lab=<id>` is not the entry point;
  `/lab.html?lab=<id>` is.

### Mistakes Made

- **Sent the maintainer a lab URL without `lab.html`.** Early signal: I had the
  correct form in front of me in `tests/e2e/**`, which uses
  `${E2E_LAB_BASE_URL}/lab.html?lab=…` everywhere, and still typed the short form
  from memory. Fix applied: `npm run lab` now prints the URL itself, so the
  correct form no longer depends on recall.
- **Left a stale dev server holding port 15281 from earlier in the session.** A new
  `npm run lab` silently bound 15282, so the maintainer's browser loaded an **old
  build** of a URL that looked correct — which reads as "your fix doesn't work"
  rather than "you're on the wrong server". Early signal: Vite's banner said 15282
  and I did not reconcile it against the URL I had already handed over. Fix: before
  relaunching, `Get-NetTCPConnection -LocalPort 15281 -State Listen` →
  `Stop-Process -Id <pid>`, and launch **detached** so the server outlives the tool
  call.
- **The parent handoff declared invalid `Systems touched` slugs** (`terrain-packs`,
  `rendering` — neither is a heading in `docs/systems/README.md`), so it would have
  been dropped from the generated system-impact index. Corrected to
  `sprite-pipeline, mapgen, devtools` in the same commit. Early signal: I wrote
  plausible-sounding slugs instead of reading the canonical list.
- **Assumed PR #2330 was still open.** It squash-merged while I was building the
  scene, so `sync:main` hit a rebase conflict against my own already-merged
  commits. Recovering was cheap (`reset --hard origin/main` + cherry-pick of the
  one new commit), but checking PR state before a pre-publish sync would have been
  cheaper.

### Opportunities for Future Improvement

- Vite's `server.open` is `false` in lab mode; now that the correct URL is computed
  in a plugin, `npm run lab` could optionally open it directly.
- The `SCENARIO_VISUAL_BRIGHTENING` table and the scenario preset list are two
  places that must be kept in sync by hand. A single preset record carrying its own
  optional lighting profile would remove that coupling.
- `?scenario=<id>` is the only deep-linkable lab state today. Seed and AI-mode
  dropdowns would benefit from the same treatment, making any lab observation
  reproducible from a single URL.
