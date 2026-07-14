# Handoff — Derived sprite anchor

**Date:** 2026-06-06
**Branch:** `nalfeo/derived-sprite-anchor` (off `main`)
**Persona:** graphics-designer

## Summary

Replaced the static `anchor-opaque` sensor with a per-variant `anchor-derivable`
sensor for handheld weapons. The old contract — "every variant must have an
opaque pixel at brief-declared (x, y)" — fails for slender weapons (e.g.
katana) where the grip column drifts across variants. The new contract finds
the grip pixel from the silhouette: the bottom-most opaque row's
center-most opaque run midpoint, subject to a tolerance band.

Behavior is gated by `sensors.anchor.derive` on the brief, and
`data/sprite-types/weapon.json` flips the default on for all weapon briefs.
Fully backward-compatible for any brief that doesn't opt in.

## Files touched

**New**

- `scripts/sprites/sensors/derive-anchor.ts` — pure algorithm
- `scripts/sprites/sensors/anchor-derivable.ts` — sensor wrapper +
  `isAnchorDerivableOk` type guard
- `data/sprite-types/weapon.json` — sensor defaults for weapon type
- `tests/unit/sprites/derive-anchor.test.ts` (9 tests)
- `tests/unit/sprites/anchor-derivable.test.ts` (7 tests)

**Modified**

- `scripts/sprites/brief-schema.ts` — added `sensors.anchor` block
- `scripts/sprites/score-candidate.ts` — routes anchor sensor based on brief
  opt-in; surfaces `derivedAnchor` on `Scorecard`
- `scripts/sprites/run-artifacts.ts` — `derivedAnchor` on `RunSummaryEntry`,
  `RunSummary.chosen`, `pickChosen()` helper, per-variant
  `processed/NN.anchor.json` sidecar
- `scripts/sprites/generate-one.ts` — threads derived anchor + chosen
- `scripts/sprites/cli.ts` — prints chosen line, includes anchor in
  `selection.json`
- `scripts/sprites/load-brief.ts` — sprite-type defaults merge into
  `sensors.*` (one level deep, brief wins per key)
- `tests/unit/sprites/score-candidate.test.ts` — adds derivedAnchor coverage
- `tests/unit/sprites/load-brief.test.ts` — sprite-type defaults coverage

## Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npx vitest run --project unit` — **593/593 pass**
- `npx vitest run --project integration` — **10/10 pass**
- `npx prettier --check` on all changed files — clean
  (the repo has pre-existing prettier drift across 188 unrelated files; not
  addressed here to keep the diff focused on this feature)

## Unresolved

- **End-to-end Azure validation with katana was skipped.** The katana brief
  lives on PR #28 and uses a different schema (variations expander) that
  hasn't landed on `main` yet. Once PR #28 merges, the katana brief picks
  up `anchor.derive: true` for free via the weapon sprite-type default.
- **No iron-sword centerToleranceX widening was needed in this PR** because
  no Azure run was performed. If a real-world iron-sword run lands diagonal
  blade grips outside the default ±3 band, add
  `sensors.anchor.centerToleranceX: 8` to that brief — but don't widen the
  default.

## Next steps

1. After PR #28 (variations expander + katana brief) merges, run
   `npm run sprites:run -- briefs/weapons/katana.yaml` to confirm the
   pipeline actually passes 15-16/16 variants on the new sensor.
2. Promote chosen sprites through the runtime `SpriteAnchor` type (#31) —
   the derived anchor sidecar JSON is exactly the shape `SpriteDef.anchor`
   expects.
3. Consider deriving anchors for `helmet` / `armor` sprite types too, but
   with a top-center rather than bottom-center search policy. Out of scope
   for this PR.
