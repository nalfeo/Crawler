# Handoff: DOOR — Floor-1 closed doors stamp approved generated art (F1 terrain 6/6)

## Systems touched

sprite-pipeline, mapgen

## Summary

The final Floor-1 **art** gap. Dungeon doors rendered only Kenney placeholder
frames even though a human-approved GENERATED closed-door texture
(`tile-door-v1-var-0`, 256²) already sat on `main`, unwired. Doors are an
**overlay** — `updateDoorOverlay()` (MainGameScene) draws them per-frame at depth
−19 with an open/closed read — so (per the w2 plan-review finding) baking the art
into the terrain RenderTexture would double-render and break the animation. This
change wires the generated CLOSED art into the door overlay itself, keeping the
Kenney closed frame → solid-color paths as ordered fallbacks. **Non-destructive:**
the OPEN state deliberately stays on the Kenney open frame (no approved open-door
variant exists yet), and generated art is provably unreachable for open doors.
3🍎 engine change, full harness + review ledger. Closes F1 terrain to **6/6**.

## What shipped

- **`src/engine/sprites/door-visuals.ts`** (NEW) — a pure, Phaser-free helper
  `resolveDoorRenderMode(isOpen, { hasGeneratedClosed, hasSheet })` returning a
  `DoorRenderMode` discriminated union (`generated | kenney-closed | kenney-open |
color`), plus the exported constants the renderer stamps
  (`GENERATED_DOOR_TEXTURE_KEY = 'tile-door-v1-var-0'`, `DOOR_SHEET_KEY`,
  `DOOR_CLOSED_FRAME = 46`, `DOOR_OPEN_FRAME = 34`). **Mode-selection only** — no
  asset dimensions, so it stays unit-testable in isolation. Precedence: CLOSED →
  generated → Kenney closed frame → color; OPEN → Kenney open frame → color.
- **`src/engine/scenes/MainGameScene.ts`** — `updateDoorOverlay()` rewritten to
  derive the generated-door scale **from the actual loaded texture width**
  (mirroring terrain-renderer's `resolveGeneratedScale`: `getSourceImage().width >
0 ? tileSize/width : null` → `hasGeneratedClosed`), call the pure helper per
  door, and render per mode through a single `addDoorImage` closure that preserves
  every per-door invariant (`setOrigin(0.5)`, `setDepth(-19)`, `uiCamera?.ignore`,
  `doorImages.push`). Added a `doorRenderSummary` field with **5 mutually-exclusive
  provenance buckets** + `renderableClosedCount` (sum of the 3 closed buckets),
  zeroed on **every** exit including the early-return, and a `getDoorRenderSummary()`
  accessor (the observe seam).
- **`src/labs/main-scene-probe-lab/index.ts`** + **`tests/e2e/helpers/main-scene-probe.ts`**
  — `DoorRenderSummary` interface + `getDoorRenderSummary()` on the probe API, the
  `MainSceneInternals` structural cast, and the typed e2e wrapper (no cross-layer
  import).
- **`tests/unit/door-visuals.test.ts`** (NEW, 9 tests) — the exhaustive
  2×2×2 input matrix for `resolveDoorRenderMode` (all 4 `isOpen=true` combinations
  pinned so generated art can never leak into the open state) + a constants-lock
  test.
- **`tests/e2e/generated-door-overlay.test.ts`** (NEW, 1 test) — boots the REAL
  MainGameScene via the probe lab.

## Observe-before-done (rule #10 / #15 — REAL artifact, not just a lab)

Observed in the REAL booted `MainGameScene` via `main-scene-probe-lab` (not a
lab-only claim; the door overlay is force-called by the real scene each frame):

- **Before:** the booted Floor-1 map's closed wall-flanked doors rendered Kenney
  frame 46 — `closedGeneratedCount == 0`, `closedKenneyCount == 74`.
- **After:** the same 74 doors stamp the generated texture —
  `closedGeneratedCount: 74, renderableClosedCount: 74, closedKenneyCount: 0,
closedColorCount: 0`. The e2e asserts `renderableClosedCount > 0` **AND**
  `closedGeneratedCount === renderableClosedCount` **AND**
  `closedKenneyCount + closedColorCount === 0` — a Kenney-only render (the
  pre-wire behavior) fails the identity immediately, and the
  `renderableClosedCount > 0` guard prevents a false pass on a map with no
  eligible closed door.
- The unit test independently proves per-mode selection: CLOSED prefers generated
  (independent of the Kenney sheet), falls through to Kenney-closed then color;
  OPEN prefers Kenney-open then color and **never** returns `generated` in any of
  its 4 input combinations.

`updateDoorOverlay` is a private scene method (not an exported `*System`) and
`resolveDoorRenderMode` is a plain pure function called from it, so no
`check:wired-systems` concern.

## Verification

- `npm run typecheck` — clean (exit 0).
- `npm run verify:fast` — ✅ unit tests + guards green.
- Unit: `tests/unit/door-visuals.test.ts` — 9 passed.
- e2e: `tests/e2e/generated-door-overlay.test.ts` — 1 passed (real scene).
- Review ledger `docs/knowledge/review-ledgers/2026-07-08-f1-door-overlay-generated.review-ledger.json`
  — valid 3🍎 ledger (plan_review gpt-5.4 minor 7/7; code_review Sonnet 4.6, 2
  rounds → clean).
- Headless Floor-1 gate: **not** run locally — a render-layer overlay change that
  touches no `src/core` / `src/game/ai` / balance code and cannot affect the
  headless sim or win-rate; the required CI `test-headless` job still enforces it.

## Next steps

1. Land this PR (arm `--auto --squash` — gameplay-neutral render-only overlay
   change, within the Graphics lane).
2. **OPTIONAL open-door variant** — if/when an open-door sprite is generated, wire
   it into the `kenney-open` branch's precedence (helper already isolates the open
   path). Non-blocking; queued by the orchestrator.
3. **CORRIDOR manifest-trim** — optional catalog hygiene (5 unused variants); not
   wiring-PR scope. F1 terrain art is fully wired at 6/6 after this.

## Apple estimate

Declared **3🍎**; actual **3🍎** — one engine method rewrite plus a pure helper
module, a thin observe seam, and two tests. Code-review surfaced one non-blocking
test-completeness gap (the 8th input combination), resolved by adding the exact
case the reviewer specified. Verdict: **recommended**, shipped clean.
