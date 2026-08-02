# Session Handoff: Mob sprite scaling by authored world footprint

## Date

2026-08-02

## Persona

Producer → Engine/Rendering

## Systems touched

enemies, sprite-pipeline, boss-rooms

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Mobs were sized by a **raw pixel multiplier** (`renderKinds.*.generated.scale` in
`src/shared/data/entity-sprite-mappings.json`, e.g. `0.4`) that was tuned when all
generated enemy art was 64×64. The sprite pipeline's enemy brief default later grew to
256×256, and `load-brief.ts` auto-applies `sizeVariant: large` (512×512) to
`mobRole: boss`. Nothing in the renderer read native texture pixels, so every mob drawn
from newer art rendered 4–8× oversized — that is the "HUGE mobs" report.

Fix: mob size is now **authored in world feet** and fitted to the variant's opaque
bounds.

- `entity-sprite-mappings.json`: added `generated.heightFt` to all 8 enemy render kinds
  (mooks/spawners 2.4–3.2 ft, bosses 7.0 ft). `player` deliberately keeps the pixel
  multiplier — `tests/unit/player-npc-scale-parity.test.ts` pins it to the welcome-room
  NPC.
- `src/shared/generated-assets.ts`: new pure `resolveGeneratedFootprintScale()`, a thin
  named wrapper over the **existing** `resolveOpaqueFit` (already used by the set-piece
  prop path) — height-authoritative so authored aspect is preserved, and it degrades to
  whole-canvas fitting when bounds are missing.
- `src/engine/PhaserBridge.ts`: `resolveGeneratedTexture` now carries `heightFt`, and a
  single `resolveBaseScale(obj, resolved)` helper is applied at all 5 visual
  creation/retexture sites. Falls back to `generated.scale` when the texture is
  unmeasurable (headless/stub scenes, undecoded art) so an unknown texture reverts to the
  old look rather than a bogus size.
- `computeEnemyScale` is untouched: cosmetic `sizeScale` (±10%) and the spawn pop still
  multiply on top.

**Observed in the real artifact** (bridge-level test driving the real
`PhaserBridge.sync` over the real shipped manifest shards, per rule #9 —
`tests/unit/mob-render-footprint.test.ts`): Floor 1 rat **2.05 ft → 3.2 ft** tall;
Floor 2 goblin family boss **56.75 ft → 7.0 ft**; boss/rat drawn-height ratio
**27.7× → 2.2×**.

Deterministic backstop added (`tests/unit/mob-footprint-guard.test.ts`, mutation-tested):
every generated enemy render kind must declare a `heightFt` in a sane band, and every
approved `type: 'enemy'` manifest entry must have opaque bounds whose implied drawn width
at the mook height stays inside a feet band. This is precisely the check that was missing
when the canvas default changed to 256.

## Key Decisions Made

- **Feet, not pixels, are the authored unit for mobs.** Canvas size becomes a pipeline
  implementation detail instead of a hidden renderer coupling.
- **Height is authoritative, not a `Math.min` contain-fit.** A contain-fit silently
  discards the looser axis and would squash deliberately wide art (`gnome-wheelman`,
  639×180 opaque) to ~1.7 ft tall. Same reasoning already documented in the set-piece prop
  path.
- **One `heightFt` per render kind, not per archetype.** All 61 Floor 2 non-boss
  archetypes route through `spriteTexture: 1` → `enemy_rat` and resolve their own art via
  the global appearance-key registry — the *same* code path Floor 1 rats use. Footprint
  therefore cannot be split by code path. Floor 2 bosses use `spriteTexture: 5` →
  `enemy_family_boss`, which has its own knob.
- **Rejected** per-archetype `spriteWidth`/`spriteHeight` from `enemies.floor*.json` as the
  source of truth: those are collision proxies (goblin-grunt 1.8 ft, bosses 3.0–3.2 ft) and
  would render bosses smaller than rats.
- **Sprite origin left at 0.5/0.5** — only scale changed, to avoid disturbing flash
  overlays, corpse shatter, and health-bar placement.

## What's Next / Blockers

- **OPEN QUESTION / success gate:** the standard mook height of **3.2 ft** is *not yet
  confirmed by the maintainer*. It was chosen because it matches the Floor 1 rat's
  pre-existing *canvas* footprint, but it makes the rat's *visible* art grow from ~2.05 ft
  to 3.2 ft. If the answer is a different number, it is a one-line data change in
  `entity-sprite-mappings.json` (plus the boss number, currently 7.0 ft) — no code change.
- No PR was opened (not requested). A ≥3🍎 review harness + review ledger is required
  before publishing one.
- Follow-up worth considering: give the *sprite pipeline* the same feet vocabulary so a
  brief declares its intended footprint, letting the guard compare authored intent against
  authored render size instead of only bounding the ratio.

## Retrospective

### Lessons Learned

- `resolveOpaqueFit` already existed and already did exactly the right math for the
  set-piece prop path. Reusing it (rather than writing a second fitter) meant the mob fix
  was ~20 lines of real logic; the rest was authoring data and guards.
- The manifest shards under `public/assets/generated/entries/*.json` carry
  `opaqueBounds` **with `canvasWidth`/`canvasHeight`**, which makes an offline,
  no-Phaser deterministic size guard possible. Any future "is this art the right size on
  screen" question should be answered from those shards.
- `mobRole` exists in sprite *briefs* but not in manifest *entries*, so the runtime cannot
  key sizing on role — role-dependent sizing has to come from the render kind.

### Mistakes Made

- Extended `MockImage` in `tests/fixtures/phaser-bridge-harness.ts` to report a native
  texture size, and had `setTexture` unconditionally re-apply it — which **zeroed
  `width`/`height` that existing tests assign by hand after construction**, breaking two
  unrelated set-piece tests. Early signal: a test failing with "expected 0 calls, got 1"
  on a code path you did not touch means a shared fixture, not the feature. Fix: a size
  resolver must be a **no-op for keys it does not know**, never a clobber.
- Imported `PIXELS_PER_FOOT` from `src/shared/constants.js` (it lives in
  `src/shared/units.js`). TypeScript did not object in the test because the assertion
  swallowed it as `NaN`. Early signal: an assertion reporting `expected NaN` is almost
  always an undefined import, not a logic bug.

### Opportunities for Future Improvement

- `tests/unit/floor2-boss-render-art.test.ts` asserts base scale exactly 1.0 and now only
  passes because its stub scene reports no texture size (legacy fallback). It has a comment
  saying so, but it would be stronger re-expressed in drawn feet.
- Several render kinds still carry both `scale` and `heightFt`. Once every generated kind
  (including `player`) is authored in feet, `scale` can be deleted and the fallback path
  removed — worth a small dedicated session.
- The guard bounds width but not the ratio of authored height to what the brief *asked
  for*. Wiring brief intent into the manifest would let the guard catch "the art is fine
  but the wiring is wrong" as well.
