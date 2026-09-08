# Session Handoff: Floor 3 Daylight Ambient Regression Guard

## Date

2026-09-07

## Persona

Lighting specialist

## Systems touched

lighting

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

Kept Floor 3's authored outdoor ambient at `0.45` and strengthened the
regression contract around it. Unit coverage now pins the manifest value, and
the real MainGameScene probe boots through `createFloorMainSceneOptions('floor3')`
and asserts that the live lighting configuration receives the same value.
Existing deterministic Floor 2 versus Floor 3 rendered-pixel brightness
coverage remains the visual hard gate.

## Files touched

- `tests/unit/floor-manifests-lighting.test.ts`
- `tests/e2e/lighting-defaults.test.ts`

## Real-scene evidence

The Floor 3 e2e assertion observes `window.__floor1Debug.lighting.getConfig()`
after the shipped bootstrap and scene create path complete. The companion
`terrain-generated-tiles` brightness test compares fixed-seed rendered Floor 3
terrain against Floor 2 and requires more than twice the mean luminance and a
lit fraction above `0.60`.
