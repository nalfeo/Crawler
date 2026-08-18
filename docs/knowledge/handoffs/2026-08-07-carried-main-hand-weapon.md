# Session Handoff: Always-visible carried main-hand weapon

## Date

2026-08-07

## Persona

Engine / Render

## Systems touched

weapons, vfx

## Apples

2🍎 exact

## What Was Done

The player's weapon was only drawn while a transient `MeleeSwing` entity existed,
so between swings — and for every weapon that never spawns a swing — the player
rendered empty-handed. Added a persistent carried-weapon sprite to
`PhaserBridge.sync()`, driven by the active main-hand weapon def
(`getActiveWeaponDef`), with the placement/art-selection math extracted into pure
helpers in `src/engine/phaser-bridge/carried-weapon.ts`.

- Art order: real (non-placeholder) generated art → Kenney melee stand-in
  (`weapon.bat` for `baseball-bat`, `weapon.sword` for other melee) → generated
  placeholder only when no Kenney stand-in exists → draw nothing. A bow never
  renders a sword.
- The carried sprite is hidden while that player owns a `MeleeSwing` (the swing
  sprite takes over) and while the player sprite itself is hidden.
- Carry length is 60 % of melee swing reach — swing sprites scale so the tip
  lands at full `aoeRadius`, which reads far too long for an idle carry.
- Facing is latched from the same velocity-epsilon rule the player sprite uses,
  so hand and body never disagree.
- Cleanup on entity removal and on `bridge.destroy()`.

Observed in the REAL booted `MainGameScene` (probe lab boots it through the
shipped floor bootstrap, fixed seed) via the new
`getCarriedWeaponRenderInfo()` display-list probe — before: `spriteCount 0`
while idle with `sword` equipped; after: `spriteCount 1`, `visible true`,
offset within arm's reach of the player. Locked in as
`tests/e2e/carried-weapon-visible.test.ts`, which was confirmed to FAIL against
the pre-fix `PhaserBridge.ts`.

## Key Decisions Made

- The carried sprite is named `carried-weapon:<eid>` on the display list, so
  real-scene probes identify it structurally instead of guessing from texture
  keys (same convention as blood pools and quest arrows).
- Placement math lives in a Phaser-free module so it is unit-testable without a
  scene stub; the bridge only does texture resolution and object lifecycle.
- Texture reconcile is guarded on key/frame change (with `String()` frame
  coercion) to avoid a `setTexture` every frame — mirrors the swing branch.

## What's Next / Blockers

- Only `baseball-bat` has real generated weapon art; every other melee weapon
  carries the Kenney sword stand-in. Generating per-weapon carry art would make
  the hand read correctly for swords/axes/knives.
- Ranged weapons (bow, wand) still carry nothing — deliberately, since drawing a
  melee stand-in for them would be wrong. They need their own art briefs.

## Recovery Validation

This work was recovered on 2026-08-17 from the abandoned
`copilot/players-main-hand-weapon-visible` branch (tip 2026-08-07), which never
had a PR. The branch was found during a repo-wide audit of 1,126 remote branches
for work lost to interrupted sessions. Original commits:
`d650825c1` (`feat(engine): always render the player's carried main-hand weapon`)
and `3a5955465` (`test(e2e): deterministic real-scene guard for the carried main-hand weapon`).

After rebasing onto current `origin/main`, the real `npm run dev` artifact was
booted through `MainGameScene` on the fixed-seed probe lab and freshly observed:

- Starter baseball bat: `spriteCount 1`, `visible true`, texture
  `baseball-bat-v1-var-0`, offset `(4.4, 1.2)` px.
- Explicitly equipped sword: `spriteCount 1`, `visible true`, texture
  `kenney-tiny-dungeon`, offset `(4.4, 1.2)` px, display size `28.8 × 28.8` px.
- Explicitly equipped bow: `spriteCount 1`, `visible false` (stale display object
  is retained but hidden), confirming ranged weapons do not show a melee stand-in.

The rebased deterministic real-scene guard passed both tests:
`tests/e2e/carried-weapon-visible.test.ts`.

## Retrospective

### Lessons Learned

- Screenshot pixel-diffing the live dev game is NOT a valid observation
  instrument: a repeat after-vs-after capture of a 180×180 player-centred crop
  showed a ~3853-pixel noise floor (idle animation, VFX, sim advance), which
  exceeded the ~3612-pixel signal being measured. Use a display-list probe
  against the probe lab's real booted scene instead.
- The Phaser `Game`/`Scene` is not reachable from `window` in the shipped game,
  so display-list inspection has to go through `main-scene-probe-lab`'s
  `window.__mainSceneProbe`.

### Mistakes Made

- Spent a chunk of the session building a Playwright screenshot-diff harness
  before validating the instrument against itself. Early signal: the first
  after-vs-after control run should have been the FIRST measurement taken, not a
  sanity check run afterwards. Always measure the noise floor before trusting a
  diff.
- Initially drew the carried weapon at full swing reach, which looked absurdly
  oversized; the swing sprite's scale rule (tip at `aoeRadius`) does not
  transfer to an idle carry.

### Opportunities for Future Improvement

- A generic "display-list object by name prefix" probe accessor would remove the
  need to add a bespoke probe method per visual feature.
- Carried weapons could bob/sway with the walk cycle; currently the sprite is a
  fixed offset from the player's centre.
