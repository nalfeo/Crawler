# ADR: Floor-2 family-boss generated-art render wiring

## Status

Accepted

## Date

2026-07-08

## Estimated Complexity

🍎 x 3 — cross-layer (engine resolver + game spawn + shared data) render/data
wiring for 18 Floor-2 bosses + 44 archetype→brief mappings, full-gate with two
guard tests. No new algorithm/system — it reuses the existing `enemy_rat`
generated-texture pattern.

## Context

`enemies.floor2.json` declares 44 Floor-2 enemy archetypes (18 crime-family
bosses + 26 grunts/cave-ambient). ~43 of them already had real generated art merged on
`main`, but **all three sprite-resolution surfaces were Floor-1-only**, so every
Floor-2 enemy rendered a family-tinted Kenney/rat **placeholder** in-game and the
~43 shipped sprites were inert — a violation of project rule #10 / ADR 0039 (every
generated asset must reach the real render path; every system wired or
allowlisted).

Floor-1 enemy wiring (rat family, slimes, monarchs — see the
2026-07-07 rat-spawner-appearance-hookup ADR) already established the pattern:
enemies resolve generated art via an appearance-key → generated-brief map plus a
`renderKind` carrying a `generated` block. This decision extends that **same**
pattern to Floor-2 bosses; it does not introduce a new mechanism.

The 18 bosses are spawned by `floor2Scenario.spawnFamilyBoss` and are distinguished
at render time only by `FamilyMembership.isBoss` (they are **not** in
`objective.bossBattles`), so in `PhaserBridge.sync` they derive `isBoss=false` and
fall through to `enemyVariantFromTextureId(spriteTexture)`. On `main` every boss
carried `spriteTexture: 1` (a generic Kenney frame) and **no appearance key**, so
they could never resolve their own generated art.

## Decision

Data-driven wiring, **zero engine-logic change** (mirrors `enemy_rat`):

1. **New `enemy_family_boss` render kind** in
   `src/shared/data/entity-sprite-mappings.json`: an `enemies` map entry
   (`textureId: 5`) — which auto-wires `5 → enemy_family_boss` in the
   JSON-built `enemyVariantFromTextureId` table — plus a `renderKinds.enemy_family_boss`
   with a `generated` block (`briefId: goblin-boss`,
   `pinnedTextureKey: goblin-boss-var-0`, `scale: 1.0` = LARGE 2×2 tiles).
2. **All 44 Floor-2 archetype ids → generated brief** added to
   `GENERATED_BRIEF_BY_APPEARANCE_KEY` in
   `src/engine/phaser-bridge/sprite-kind.ts` (42 identity maps + 2 plural remaps
   `raccoon-boss→raccoons-boss`, `imp-boss→imps-boss`, because the briefs shipped
   plural while archetype ids are singular). `GENERATED_BRIEF_BY_TYPE.enemy_family_boss
= 'goblin-boss'` is added as a defensive type-level fallback.
3. **Boss appearance key set on spawn**:
   `src/game/floor2Scenario.ts` `spawnFamilyBoss` now calls
   `setEnemyAppearanceKey(world, eid, archetype.id)` (grunts already set theirs),
   so the appearance-key map — which the resolver checks **before** the type map —
   resolves each boss's own art.
4. **18 boss archetypes** in `src/shared/data/enemies.floor2.json` change
   `spriteTexture: 1 → 5` (grunts stay 1, cave-slime stays 2).

## Consequences

### Positive

- All 18 Floor-2 family bosses now resolve their **own** generated boss sprite at a
  LARGE base scale instead of a shared placeholder; ~43 previously-inert Floor-2
  enemy sprites reach the real render path.
- No engine algorithm change — the render path, scale computation, and resolution
  ladder are untouched; identity flows entirely through data + one appearance-key
  call.
- Changing boss `spriteTexture` to 5 is render-only: the two gameplay consumers of
  `textureId` are safe — `apply-damage` passes it through to the `corpseExplode`
  render event (so boss corpses now correctly shatter their real art), and
  `dropSystem.maybeSplitSlime` returns early unless the archetype is exactly
  `'slime'` (a boss never enters it).

### Negative

- The appearance-key map grows by 44 hand-maintained entries; renaming an archetype
  id or brief on either side without updating the map silently falls back to generic
  resolution.

### Risks

- The render kind pins `goblin-boss-var-0` as the last-resort fallback for all 18
  bosses; if a boss ever spawned without its appearance key it would show the goblin
  boss. Mitigated because all 18 are in the appearance-key map and Guard B asserts
  each renders its own key.
- Per-boss silhouettes still share one base scale (1.0); a future ART-ONLY pass may
  want case-by-case large/wide/tall scaling.

## Alternatives Considered

- **Per-family render kinds (18 kinds).** Rejected: 18× the data surface for no
  benefit — one render kind + runtime appearance key already distinguishes them.
- **Rename archetype ids or regenerate the plural briefs to match.** Rejected
  (rule #12): reconciling singular↔plural at the map layer is the least-blast fix and
  touches no shipped art or gameplay ids.
- **Route bosses through `objective.bossBattles` to reuse the boss-battle render
  branch.** Rejected: that path is for scripted boss encounters, not the 18
  family bosses; the `enemyVariantFromTextureId` path is the correct, existing hook.
