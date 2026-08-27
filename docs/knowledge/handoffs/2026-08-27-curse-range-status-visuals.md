# Session Handoff: Curse trigger ring + enemy status-effect auras

## Date

2026-08-27

## Persona

`Game Designer → UX Designer` (ability tuning, then the render-side status cue)

## Systems touched

weapons, vfx, enemies

## Apples

3🍎 estimated, 3🍎 actual (exact) — see
`docs/knowledge/metrics/apples/2026-08-27-curse-range-status-visuals.json`.

## What Was Done

Fixed both halves of playtest issue #3690.

- **Curse's trigger ring was half its own blast.** The ability fired on
  `{ minEnemies: 4, withinFeet: 8 }` while `spell_enemy_slow_burst` covers
  `radiusTiles: 4` × `DEFAULT_TILE_SIZE_FT 4` = **16 ft**. Retuned to
  `{ minEnemies: 2, withinFeet: 16 }` so the ring equals the burst;
  `radiusTiles` deliberately unchanged. `cooldownFrames` 840 → 960 per the
  issue's literal wording — flagged in the PR as an interpretation to confirm,
  since "cooldown is too low" can mean either direction.
- **No enemy showed that it was afflicted.** Added
  `src/engine/status-effect-visuals.ts` (pure resolver, polarity from
  `(stat, op, value)`) and `src/engine/StatusEffectVfx.ts` (one shared `Graphics`
  layer at the new `WORLD_VFX_DEPTH.statusAura`, cleared and redrawn each frame),
  wired through `PhaserBridge`. The tint now fires for **any** live status, not
  only `speed`.

Observed in the **real `MainGameScene`** (booted through the shipped floor
bootstrap by `main-scene-probe-lab`, not a synthetic lab scene), pinned by
`tests/e2e/status-effect-aura-main-scene.test.ts` — before applying the real slow
debuff to a live enemy the aura layer holds **0 draw commands** and **0%** of the
80×80 px box around that enemy differs; after, the layer draws and **20.7%** of
the same box changes. That 0% before is exactly the "no visual effect" the issue
reports.

## Key Decisions Made

- Size an `enemy_cluster` trigger ring to the ability's own effect radius rather
  than treating them as independent numbers.
- Do **not** widen the burst as well: the reachability bug did not justify a
  balance buff.
- One shared aura `Graphics` instead of one per entity — a per-entity object
  needs an EID-keyed lifecycle, which is precisely what bitecs entity recycling
  makes hazardous.
- Derive buff/debuff polarity from `(stat, op, value)`; `stat` alone would make a
  haste and a curse render identically.
- Fixed priority list for multi-effect entities so the chosen visual is
  independent of application order.

Full rationale + alternatives:
`docs/knowledge/adr/2026-08-27-status-effect-aura-and-curse-trigger-ring.md`.

## What's Next / Blockers

- **Open question for the maintainer:** the cooldown direction. If "cooldown is
  too low" meant "Curse is available too rarely", flip `cooldownFrames` back in
  `src/shared/ability-presentation.ts` — one line, no other change.
- The AI equipment-loadout evaluator reads Curse's `minEnemies`/cooldown
  dynamically, so seeded headless outcomes can shift. Watch the win-rate gates on
  this PR rather than assuming neutrality.
- Only enemies get an aura today. The player carries statuses too; extending the
  same target list to the player sprite is a small follow-up, deliberately left
  out to keep this change scoped to the reported bug.

## Retrospective

### Lessons Learned

- `main-scene-probe-lab` is the right observe-before-done seam for render-bridge
  work: it boots the **real** `MainGameScene` through the shipped bootstrap, so
  the evidence is not lab-only.
- When converting a world position to screenshot pixels, **camera zoom is not
  optional**. `ftToPx(pos) - cam.worldView.x` alone put the sample box at half
  the correct offset and produced a confident, wrong 0% pixel diff on a feature
  that was in fact rendering. Multiply by `cam.zoom`, then scale again by
  `boundingBox().width / GAME_W` for the letterboxed canvas.
- A cooldown assertion at exactly `base - 1` frames fails: `setupPlayer()`'s
  baseline stats carry a small non-zero `cooldownReduction`, so the effective
  cooldown sits just under the authored value. Assert generous windows.

### Mistakes Made

- Spent two e2e runs chasing a "the aura does not render" ghost that was purely
  my screenshot coordinate math. **Early signal I ignored:** the probe already
  reported `layerVisible: true` with a non-zero draw-command count while the
  pixel diff was exactly `0` — a _perfect_ zero next to a positive
  display-list signal means the sample box is in the wrong place, not that
  nothing drew. Add the display-list assertion first and trust it over the
  pixels.
- Two `edit` calls silently joined adjacent lines because the replacement text
  dropped a trailing newline. Always re-read the edited region afterwards.
- The first plan proposed _lowering_ Curse's cooldown; the separate-model plan
  review caught that this implements the opposite of the issue's words. Ambiguous
  playtest wording deserves an explicit interpretation statement in the plan, not
  a silent pick.

### Opportunities for Future Improvement

- `resolveStatusVisual` is the natural place to hang a HUD status-icon row and a
  player-side aura; both are currently unbuilt.
- An `enemy_cluster` trigger whose `withinFeet` is smaller than the radius of the
  effect it casts is a mechanical, checkable defect. A deterministic registry
  guard could reject that pairing outright instead of waiting for a playtest
  report — this is the second issue (#3690, #3677) filed against the same shape.
- `getEntityCameraPosition` added to the probe lab generalises past this test;
  future pixel probes should use it instead of re-deriving camera math.
