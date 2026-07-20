# Handoff: Queen Mab Verdigris Glamour arena slice

## Date

2026-07-17

## Persona

Producer

## Systems touched

enemies, boss-rooms, weapons, vfx, ai-behavior-tree, hud-ux, sprite-workflow

## Apples

5🍎 estimated → 5🍎 actual. This is a multi-system vertical slice: a new
Phaser-free typed ability runtime, a Queen Mab ability adapter, a status-effect
integration (new `attackSpeed` stat), canonical-pipeline + arena wiring behind a
default-off gate, a full procedural renderer, a versioned generated-art manifest
with its own validator/CLI, and honest status/spec/ADR updates. Review evidence:
`docs/knowledge/review-ledgers/2026-07-17-queen-mab-verdigris-glamour.review-ledger.json`.
Complexity record:
`docs/knowledge/metrics/apples/2026-07-17-queen-mab-verdigris-glamour.json`.

## Summary

Implemented the reusable, mob-agnostic ability runtime and Queen Mab Tarnish's
**VERDIGRIS GLAMOUR** as an arena-only vertical slice, stacked on the PR #1243
combat-arena branch and the approved Floor 2 catalog commit. The system is wired
into the canonical simulation pipeline but is **disabled by default** in the real
game — only the combat arena lab enables it. The other 17 Floor 2 abilities are
deliberately NOT implemented and remain blocked.

Hard success gate is met deterministically: an arena run records exactly two
fully-resolved casts with the exact phase cadence, and the default normal-game
configuration records zero casts/events over the same duration.

## What Changed

### Core runtime (Phaser-free, `src/core/mob-abilities/`)

- `types.ts` — typed cue/instance/runtime state, `MobAbilityCircleGeometry`,
  `mobAbilitySourceId`.
- `runtime.ts` — `mobAbilitySystem` (no-op unless `enabled && encounterActive`),
  register/clear, encounter activate/disable, caster validity, telegraph that
  commits target+origin+geometry **once** and never tracks after lock, resolution
  that anchors the cooldown after resolve. Fixed-step timer keyed on
  `GAME.DELTA_MS`; no `Math.random`/`Date.now`. `findDefaultTarget` skips
  dead/absent players so a phantom telegraph is never fired.
- `verdigris-glamour.ts` — typed catalog adapter (reads named catalog fields by
  id with validation; NOT a `designValues` DSL) + resolve handler. Moderate
  catalog-scoped damage (20), never PR #1237 level-scaled contact `Damage`.
  Applies Tarnished (0.70 move-speed × 0.75 attack-speed, 4s, non-stacking) and
  clears sibling Tarnished from other casters so it can never cross-caster stack.
  Resolution skips all enemies (only ever hits the player), closing a recycled-id
  friendly-fire hole.
- `index.ts` — barrel.

### Status effects & shared types

- `src/shared/status-effect-types.ts` — added the `attackSpeed` stat.
- `src/shared/announcement-events.ts` — added the `bossAbilityCast` announcement
  kind.
- `src/game/weaponSystem.ts` — folds the `attackSpeed` status multiplier into
  fire cadence.

### Wiring (canonical, default-off)

- `src/bootstrap/floor-main-scene-options.ts` — registers `mobAbilitySystem` in
  the canonical preSystems behind an explicit default-off option; the real game
  registers zero active boss definitions and emits zero casts while disabled.
- `src/labs/combat-arena-lab/{arena-data,index}.ts` — `spawnQueenMabArena` +
  `f2-queen-mab` preset enable the SAME canonical path (no lab-only mechanic
  copy). preSystems are `[weaponSystem, enemyAISystem, statusEffectSystem,
mobAbilitySystem]` so Tarnished ticks and expires in the live arena.

### Presentation (`src/engine/`)

- `MobAbilityVfx.ts` — pure consumer of committed public cue state + Tarnished
  status; draws every required phase procedurally (cast-start cue, locked
  hostile-red 12ft telegraph, countdown fill, resolution burst + gratuitous
  particles, persistent Tarnished indicator, cleanup effect). Wired into
  `PhaserBridge`.
- `HudAnnouncementBanner.ts` — renders the exact announcement treatment.

### Generated-art manifest

- `scripts/agent/data/queen-mab-art-manifest.json` — strict, versioned,
  extensible, Queen-only, all entries non-blocking with a declared procedural
  fallback.
- `scripts/agent/queen-mab-art-manifest-lib.ts` + `queen-mab-art-manifest.ts` +
  `npm run queen-mab:art-manifest` — Zod validator + CLI proving every required
  visual phase has a fallback.

### Status / spec / ADR (honest staged rollout)

- `scripts/agent/data/boss-abilities.floor2.status.json` — added the
  `floor2-boss-production-enable` gate (not-started); Queen's headless
  canonical-runtime evidence is recorded and the combat-arena observation is now
  verified via deterministic headless Chromium. She is NOT production-verified
  while the production gate is off; all 18 abilities still derive as `blocked`;
  PR #1237 is no longer an arena blocker; PR #1243 remains the authoritative
  arena dependency.
- `.specify/specs/boss-abilities.md`, `docs/knowledge/adr/0064-*.md`,
  `tests/unit/boss-ability-catalog.test.ts` updated to match.

## Key Decisions

1. The executor is a typed adapter + named handler per ability, not a
   `designValues` interpreter. New abilities add adapters, not DSL surface.
2. Simulation state and events are Phaser-free; the renderer consumes only
   committed public cue state from telegraph-lock time onward.
3. Ability clocks begin only when the encounter is explicitly activated
   (`activateMobAbilityEncounter`), aligning with the future
   `floor2ObjectiveTick`/`encounter.started` transition — never init spawn.
4. Non-stacking Tarnished is enforced via the `replace` stack rule PLUS an
   explicit sibling-clear, so neither same-caster refresh nor cross-caster casts
   compound the multipliers.
5. Fixed-step timer with a 1e-6 epsilon; all catalog durations are integer
   multiples of `GAME.DELTA_MS`, so cadence is exact and frame-aligned.
6. Production stays default-off. Only the arena preset enables the canonical
   path. Queen must not derive as production-verified until the separate
   production/balance gate is resolved.

## Review Summary

- Adversarial plan review (gpt-5.6-terra): 3 alternatives considered, 6 concerns,
  all resolved/accepted; minor plan divergence (design held; changes were
  hardening).
- Code-review loop (claude-sonnet-4.6): 2 bounded rounds. Round 1 found a
  High-severity bug — the arena omitted `statusEffectSystem`, so Tarnished never
  expired; fixed. Final round clean.
- Multi-model review (gpt-5.3-codex + gemini-3.1-pro-preview, adjudicated by
  claude-opus-4.8): bounded to 2 rounds with escalation when concerns remain.

## Verification

- `npm run verify:fast` — pass (typecheck + lint + changed unit tests).
- `npx vitest run tests/unit/mob-abilities/verdigris-glamour.test.ts` — 25 tests
  pass, including the exact cadence and zero-when-off cases.
- `npm run check:wired-systems` — pass (`mobAbilitySystem` wired).
- `npm run review:ledger -- validate` — valid 5-apple ledger.
- `npm run queen-mab:art-manifest` — manifest valid; every required phase has a
  fallback.
- Arena evidence (`npx tsx scripts/agent/queen-mab-arena-evidence.ts`):
  - ARENA: telegraph starts 9000/19500 ms (frames 540/1170), resolutions
    10500/21000 ms (frames 630/1260), 2 `bossAbilityCast` events, exact
    announcement string. Gate cadence 540/630/1170/1260 → PASS.
  - DEFAULT NORMAL GAME: runtime disabled, 0 registered casters, 0 casts. → PASS.

Deterministic runtime observation is recorded by the canonical simulation
harness (`scripts/agent/queen-mab-arena-evidence.ts`), deterministic visual
guards in unit coverage (`tests/unit/mob-ability-vfx.test.ts` — 5 tests covering
the 12ft telegraph footprint, Tarnished indicator, resolution burst, telegraph
retirement, and cleanup poof with position caching;
`tests/unit/combat-arena-lab-wiring.test.ts`), and a real browser-lab before/after
probe in `tests/e2e/queen-mab-arena-observation.test.ts`. That E2E boots the
actual `combat-arena-lab`, switches to the canonical `f2-queen-mab` preset in
observer mode, pauses the real Phaser scene, and steps from frame 539 (no cue /
no announcement) to frame 540 (first telegraph + exact announcement), asserting
both the world-state transition and visible canvas diffs in the telegraph
footprint and top-center HUD banner. The `HudAnnouncementBanner` is wired into
the combat arena scene (`createHudAnnouncementBanner` / `sync` / `destroy` in
`src/labs/combat-arena-lab/index.ts`), so `bossAbilityCast` announcements are
rendered in the live browser arena, and observer / immortal arena modes clear
the starter weapon so the scene shares the same passive-observer setup as the
headless evidence harness.

## Follow-ups

1. Resolve the `floor2-boss-production-enable` gate (balance + production
   enablement) as separate work; only then may Queen derive production-verified.
2. Implement the other 17 Floor 2 abilities as their own slices on the reusable
   executor (still blocked; not promoted by this slice).
3. Optional: upgrade the procedural Queen VFX with generated art per the manifest
   (non-blocking).
4. Keep production activation off until `floor2-boss-production-enable` is
   resolved.

## PR Recovery Notes (2026-07-19)

Post-merge recovery session resolved the following blockers:

- **TS2717 typecheck failure**: `queen-mab-arena-observation.test.ts` redeclared
  `Window.__arenaScene` with a richer type that conflicted with the narrower
  declaration in `combat-arena-terrain.test.ts`. Fixed by removing the `declare
  global` augmentation and using a local `QmArenaScene` interface with inline
  casts in all `page.evaluate()` / `page.waitForFunction()` callbacks. TypeScript
  erases the inline casts at compile time so the emitted JavaScript is simply
  `window.__arenaScene`.

- **E2E probe extended through full lifecycle**: The arena observation test now
  covers all five key frames — 540 (first telegraph), 630 (resolution + Tarnished
  confirmed via `statusEffectsByEntity`), 870 (Tarnished expiry + VFX cleanup),
  1170 (second telegraph), 1260 (second resolution + re-Tarnish). `ArenaProbe`
  gained a `tarnishedActive: boolean` field. `arenaLabEvidence` in
  `boss-abilities.floor2.status.json` updated accordingly.

- **PR description multi-model review section**: The committed ledger records a
  non-clean 2-round multi-model review with 1 unresolved concern escalated to a
  human (not "3 rounds, final round clean" as the original PR description stated).
  The correct statement: "Multi-model review (gpt-5.3-codex + gemini-3.1-pro-preview,
  adjudicated by claude-opus-4.8, 2 rounds): fixed dead-target lock, cross-caster
  stacking, recycled-id friendly fire; round 2 left 1 unresolved concern →
  escalated to human per the 2-round cap."

- **Merge conflict**: Resolved `docs/knowledge/handoffs/INDEX.md` after merging
  `origin/main`.

Previous recovery sessions also resolved: `foundationState: "verified"` for all
18 entries (3786bdae), `arenaLabState` requires both evidence + presetId (3786bdae),
`setActiveWeapon` immediate-fire guarantee under Tarnished (89714ae0).
