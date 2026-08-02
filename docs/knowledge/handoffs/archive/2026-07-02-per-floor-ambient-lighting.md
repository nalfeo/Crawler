# Handoff: Per-Floor Ambient Lighting + Tuned Lighting Defaults

**Session Date:** 2026-07-02  
**Session ID:** c781f408-6ef8-4831-9530-d57a1ccb2c8f  
**Branch:** nalfeo-friendly-pancake  
**Complexity Estimate:** 3🍎 (actual: 3🍎, exact)

## Systems touched

lighting

## Summary

Two related changes:

1. **Tuned the shipped lighting defaults** to the values the user dialed in via the
   AI Runner Lab's "Lighting" DevTools panel (from an attached screenshot).
2. **Made `ambient` a per-floor default** — Floor 1 ships `0.2`, Floor 2 ships
   `0.1`, and every future floor authors its own value in its manifest. All other
   lighting parameters remain global (from the engine `DEFAULT_LIGHTING_CONFIG`).

The per-floor ambient flows manifest → `FloorConfig` → bootstrap
`lightingConfig` → `MainGameScene`, applied over a clean `DEFAULT_LIGHTING_CONFIG`
base immediately before the first light-field build so both `stepPx` and `ambient`
take effect on boot.

Also fixed 3 pre-existing `tsc` errors in sprite tests that were already broken on
`main` (project rule #8 — fix failures you encounter).

## Work Done

### Lighting defaults (engine)

- `src/engine/lighting/light-field.ts` — `DEFAULT_LIGHTING_CONFIG` updated to the
  tuned values, with a comment that `ambient` here is a fallback the shipped game
  overrides per-floor:

  | field              | before          | after |
  | ------------------ | --------------- | ----- |
  | stepPx             | 8 (quarterTile) | 4     |
  | ambient            | 0.08            | 0.2   |
  | sourceRadiusPx     | 320             | 200   |
  | sourceIntensity    | 0.95            | 0.6   |
  | falloffExponent    | 1.6             | 2.5   |
  | softness           | false           | true  |
  | updateEveryNFrames | 1               | 1     |
  | autoAdjustQuality  | true            | true  |
  | targetComputeMs    | 3.5             | 10    |

### Per-floor ambient (shared → bootstrap → engine)

- `src/shared/floor-manifest.ts` — added a **required** `lighting: { ambient:
number[0,1] }` (`.strict()`) to `floorManifestDefSchema`.
- `src/shared/data/floors/floor1.manifest.json` — `"lighting": { "ambient": 0.2 }`.
- `src/shared/data/floors/floor2.manifest.json` — `"lighting": { "ambient": 0.1 }`.
- `src/shared/floor-config.ts` — added `lighting` to `floorConfigSchema` and
  `lighting: manifest.lighting` to `loadFloorConfigFromManifest`'s returned object.
- `src/engine/scenes/MainGameScene.ts`:
  - `MainGameSceneOptions` gained `lightingConfig?: Partial<LightingConfig>`.
  - `create()` applies `this.setLightingConfig({ ...DEFAULT_LIGHTING_CONFIG,
...this.options.lightingConfig })` **immediately before `drawFloorTerrain()`**
    (the first field build), which also gives a clean-base reset on scene restart.
  - Added `fieldStepPx` to the `__floor1Debug.lighting.getPerf()` seam (interface +
    impl) so tests can assert the built field's stepPx.
- `src/bootstrap/floor-main-scene-options.ts` — imported `getFloorConfig` and now
  returns `lightingConfig: { ambient: getFloorConfig('floor1').lighting.ambient }`.
  The `_floorId` param stays reserved (helper is floor1-only today).

### Pre-existing typecheck fixes (rule #8)

- `tests/unit/sprites/asset-queue.test.ts` (L117) and
  `tests/unit/sprites/issue-pipeline.test.ts` (L277, L333) — TS-recommended casts
  for union/no-index-signature access. These were red on `main` before this branch.

## Files Touched

### Source

- `src/engine/lighting/light-field.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/shared/floor-manifest.ts`
- `src/shared/floor-config.ts`
- `src/shared/data/floors/floor1.manifest.json`
- `src/shared/data/floors/floor2.manifest.json`
- `src/bootstrap/floor-main-scene-options.ts`

### Tests

- `tests/unit/light-field.test.ts` — asserts full new `DEFAULT_LIGHTING_CONFIG`.
- `tests/unit/floor1-config.test.ts` — `floor1Config.lighting.ambient === 0.2`.
- `tests/unit/floor-manifests-lighting.test.ts` (NEW) — parses every
  `src/shared/data/floors/*.manifest.json` through the schema, asserts
  `lighting.ambient ∈ [0,1]` (validates floor2 + guards future drift).
- `tests/game/floor1-main-scene-options.test.ts` —
  `createFloor1MainSceneOptions().lightingConfig.ambient === 0.2`.
- `tests/e2e/lighting-defaults.test.ts` (NEW) — boots the real `MainGameScene`
  via `main-scene-probe-lab`, reads `window.__floor1Debug.lighting.getConfig()`
  (new defaults + ambient 0.2) and `getPerf().fieldStepPx === 4`.
- `tests/unit/sprites/asset-queue.test.ts`, `tests/unit/sprites/issue-pipeline.test.ts`
  — pre-existing typecheck fixes.

### Docs / artifacts

- `docs/knowledge/review-ledgers/2026-07-02-per-floor-ambient-lighting.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-02-per-floor-ambient-lighting.json`

## Verification

- `npm run verify:fast` — ✅ typecheck + lint + changed unit tests.
- `npm run verify` — ✅ full suite: **2827 unit** (248 files), **49 integration**
  (+1 skipped), **17 headless** Floor-1 completion, format, guards, build. Only
  the handoff prerequisite was outstanding (this file); the review-ledger prereq
  passed (✅ valid 3-apple ledger).
- `npx vitest run --project e2e tests/e2e/lighting-defaults.test.ts` — ✅ 1 passed.

### Runtime observation (rule #10)

- **Before:** `DEFAULT_LIGHTING_CONFIG` shipped `stepPx 8 / ambient 0.08 / radius 320
/ intensity 0.95 / falloff 1.6 / softness false / targetComputeMs 3.5`; ambient was
  a single global constant.
- **After (observed live in the running scene via `__floor1Debug.lighting`):**
  `getConfig()` reports `stepPx 4, ambient 0.2, sourceRadiusPx 200, sourceIntensity
0.6, falloffExponent 2.5, softness true, targetComputeMs 10`, and
  `getPerf().fieldStepPx === 4` — proving the light field is actually rebuilt with the
  override's stepPx and Floor 1's per-floor ambient is applied end-to-end. Captured
  deterministically by the new e2e (fixed-seed lab boot, pure config/field reads).

### Review Harness (3🍎)

- **Plan review (gpt-5.4, 2 rounds):** REJECTED → approved_with_changes; 10 concerns,
  10 resolved (apply-before-drawFloorTerrain ordering, floor1-pinned bootstrap,
  `fieldStepPx` seam, all-manifests schema test, probe-lab observation).
- **Code review (gpt-5.4, high effort, 1 round):** no significant issues → clean.
- Ledger validated: `npm run review:ledger -- validate …` → ✅ valid 3-apple ledger
  (stages: plan_review, code_review).

## Design Decisions

1. **Manifest is the per-floor source of truth.** `src/shared/` cannot import the
   engine (layer rule), so `floor-config.ts` does not reference
   `DEFAULT_LIGHTING_CONFIG`; the engine constant's `ambient` is only a fallback for
   labs / no-floor contexts. Each floor authors `lighting.ambient` in its manifest.
2. **`lighting` is a required manifest field.** Migration is safe: only two
   `*.manifest.json` files exist (both updated), and the one in-memory manifest
   builder (`tests/unit/floor-registry.test.ts::makeManifest`) uses
   `{ ...floor1Manifest, id }`, so it inherits `lighting` automatically.
3. **Apply over a clean DEFAULT base, before the first field build.** Spreading
   `DEFAULT_LIGHTING_CONFIG` on every `create()` resets stale live-tweaks across a
   Phaser scene restart (the instance is reused; field initializers don't re-run),
   and applying before `drawFloorTerrain()` ensures the field is built with the
   correct `stepPx`. Routing through `setLightingConfig()` preserves clamping + the
   stepPx-change rebuild path.
4. **Bootstrap pinned to floor1.** The world scenario + systems are floor1-specific
   today, and `getFloorConfig('floor2')` would throw (only floor1 is registered), so
   the helper resolves floor1 explicitly and keeps `_floorId` reserved rather than
   introducing a latent throw.

## Unresolved Issues

None. Full verify is green except the handoff prereq satisfied by this file.

## Recommended Next Steps

1. Create PR (title: `feat: tune lighting defaults + make ambient a per-floor
setting`).
2. Merge with `gh pr merge --auto --squash` per repo policy.
3. When a real Floor 2 (or deeper floors) ships, tune each floor's
   `lighting.ambient` in its manifest; if future floors need to override more than
   ambient, widen the manifest `lighting` object + `FloorConfig` and thread the
   extra fields through `lightingConfig` (the plumbing already merges a
   `Partial<LightingConfig>`).
4. If multi-floor boot lands, thread the real `floorId` through
   `createFloorMainSceneOptions` (currently `_floorId`, pinned to floor1).

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

> Note: this artifact reflects pre-existing guard **test-harness** fixture events
> (names like `boom`, `pr-hard`, `shell-bad`, `edit-guard-self-protection`), not
> this session's tool calls; included verbatim per the memory policy.

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 15,
  "guards": {
    "boom": { "crash": 2 },
    "ctx": { "allow": 1 },
    "ctx-a": { "allow": 1 },
    "ctx-b": { "allow": 1 },
    "edit-bad": { "bypass": 1 },
    "edit-guard-self-protection": { "ask": 2 },
    "pr-a": { "deny": 1 },
    "pr-b": { "deny": 1 },
    "pr-hard": { "deny": 1 },
    "pr-warn": { "allow": 1 },
    "shell-a": { "deny": 1 },
    "shell-bad": { "deny": 2 }
  },
  "tools": {
    "create_pull_request": 4,
    "edit": 6,
    "powershell": 5
  }
}
```
