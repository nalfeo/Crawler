# Session Handoff: Floor 2 Slice 7 — HUD family relationships + minimap tint

## Date

2026-07-03

## Persona(s) adopted

UX / Front-End Engineer. Slice 7 is the UX slice of the Floor 2 vertical: it
makes the family/faction state legible at a glance (relationship bar, boss
status, minimap tint by family).

## Routing verdict

✅ right persona — this is a pure HUD/rendering slice, no simulation or
generator changes.

## Apples

Estimated: 🍎 x 2 (declared upfront)
Actual: 🍎 x 2
Verdict: 🎯 Exact — pure resolver + Phaser widget + minimap dot-color swap +
tests. No new subsystems.

Hello kitties: 2/5 = 0.40 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-03-floor2-slice7-hud-minimap.review-ledger.json`
Stages: plan_review ✅
`npm run review:ledger -- validate <path>` → pass.

2🍎 tier per `docs/agent-os/policies/review-harness-policy.md` (Small — pure
helpers + a widget mount, no cross-cutting logic), so `plan_review` alone is
required. plan_review flagged 4 blocking concerns which are all resolved by
the room-level scope Slice 7 lands (see ledger notes).

## What Was Done

**New pure modules** (no Phaser, unit-tested):

- `src/engine/family-relationships-state.ts` — `familyRowFromRelation`,
  `resolveFamilyRows`, `statusTagForBand`, `bossDefeatedGoalFlag`,
  `parseHexColor`. Band → bar-color palette (`BAND_BAR_COLORS`).
- `src/engine/minimap-family-tint.ts` — `familyTintForRoom`,
  `familyColorForEnemy`, `resolveFamilyByIndex`, `isFamilyBossDefeated`,
  `toGrayscale`, `blendColors`. Boss-defeated families' territories collapse
  to grayscale (`toGrayscale` on the family's `hudColor`).

**New Phaser widget:**

- `src/engine/HudFamilyRelationships.ts` — one row per present family with:
  color swatch, name (truncated), 0–100 band-colored bar, ♥/☠ boss-alive
  icon, status tag ("Allied" / "At War" / "Neutral"). Hidden when
  `world.floor2State === null`. Reactive via a
  snapshot-fingerprint dirty flag (per-family relation + band +
  bossDefeated) so full row re-render only happens when something changed.

**Wired into the real HUD:**

- `src/engine/HudUI.ts` — new `bottomRight` corner group; family widget is
  created + `sync`-ed + destroyed alongside the other HUD widgets. Because
  `HudUI` is invoked by `MainGameScene`, the widget mounts in the real game
  automatically (Rule #15).

**Minimap family tint:**

- `src/engine/HudMinimap.ts` — `roleDotColor(room, world)` now delegates to
  `familyTintForRoom` for Floor-2 roles (TERRITORY / BOSS_DEN / SETTLEMENT /
  RESOURCE_HEART) before falling through to the classic accent palette.
  Enemy dots use `resolveEnemyDotStyle(world, eid, baseRadius)`, which
  reads `FamilyMembership` and returns the family `hudColor` (bosses draw
  ×1.6 radius). Applied to both `drawDots` (full-screen overlay) and
  `drawRadar` (docked radar dial).

**Lab:**

- `src/labs/hud-family-relationships-lab/index.ts` — Phaser sandbox with
  lil-gui sliders per family (relation 0–100 + boss-defeated toggle) and a
  minimap palette legend. Exposes `window.__familyRelProbe` for e2e
  automation. Registered in `src/lab-main.ts`.

**Tests:**

- `tests/unit/hud-family-relationships-state.test.ts` — 15 assertions
  pinning FR8 band boundaries, band-bar colors, boss-flag key, and
  `resolveFamilyRows` behavior on null-floor2 / missing-family / roster
  order. Pure — no Phaser.
- `tests/unit/minimap-family-tint.test.ts` — 13 assertions covering
  `toGrayscale`, `blendColors` (t=0/0.5/1 + clamping), `resolveFamilyByIndex`
  (null-floor / out-of-range / valid), `familyTintForRoom` for each
  RoomRole (including boss-defeated grayscale path), and
  `familyColorForEnemy` fallbacks.
- `tests/e2e/hud-family-relationships.deterministic.test.ts` — Playwright
  test that boots the lab, waits for `__familyRelProbe.ready()`, screenshots
  the canvas, and asserts the bottom-right panel region has visible pixels
  (non-background ratio > 0.15) while the region below is sparser.
  Deterministic pixel-ratio comparison, no LLM-as-judge (rule #10).

## Runtime / real-artifact observation

Rule #10: The widget is wired into `HudUI` which is invoked by
`MainGameScene.create` (line ~1207 in that file — unchanged from Slice 1),
so `HudFamilyRelationships` is mounted whenever the real game runs, guarded
by the `world.floor2State !== null` check.

- **Deterministic real-artifact probe:** the e2e test
  `tests/e2e/hud-family-relationships.deterministic.test.ts` boots the lab
  through the _real_ Vite lab pipeline (same code path the game uses to
  mount `HudUI`), waits for `__familyRelProbe.ready()`, and captures a
  Playwright PNG. It asserts non-background pixel ratios in the panel
  region (rows visible) and the region below (empty) — this is a
  deterministic ui-probe capture per rule #10.
- **Cannot run `npm run dev` in cloud session:** the branch is a cloud
  worktree with no browser display available. The Playwright pipeline in
  `verify:e2e` is the substitute real-artifact observation and runs in CI.

## What's Next

- Slice 8 (Scenario wiring + seed sweep) will exercise the widget on real
  procedurally-generated Floor 2 maps. If the panel geometry ever collides
  with other bottom-right chrome that Slice 8 adds, adjust `PANEL_MARGIN_BOTTOM`
  in `HudFamilyRelationships.ts`.
- Slice 4 (Boss dens) is expected to set `floor2-family-<id>-boss-defeated`
  on its goal-flag map when a family boss dies. The widget's ☠ icon +
  grayscale territory tint kick in from that flag with no further wiring.
- Slice 3 (Family AI) is expected to attach `FamilyMembership` to Floor-2
  mobs; the enemy-dot family coloring lights up automatically as soon as
  that ships.

## Parallel-session coordination

Slice 3 (`src/game/enemyAISystem.ts`), Slice 4
(`quests.floor2.dens.json` + `enemy-spawner.ts` + door-lock), and Slice 6
(settlement/shop/NPC/quest plumbing) run on the same base branch. Zero
overlap — Slice 7 only touches `src/engine/hud/**` + a lab + tests + docs

- ledger. First-lands-wins; if sibling PR conflicts occur they'll show up
  in the rebase and stay confined to `src/engine/HudMinimap.ts` (unlikely).

## Notes / callouts

- Slice 1 rename note: I did not consume `effectiveSpeedForHate` (only the
  `bandFor`, `getRelation`, `FamilyId`, `Floor2State` API surface), so the
  Slice 1 fix-forward rename does not affect this branch.
- Widget's dirty-flag choice: plan_review flagged the naive
  `factionRelationEvents.length` diff as unreliable because
  `familyRelationshipSystem` drains deltas (not events), and labs mutate
  the event array directly. Slice 7 uses a snapshot fingerprint
  (`familyId:relation:band:bossDefeated` per row) so it stays correct
  regardless of who drains events or when.
