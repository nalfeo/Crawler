# ADR 2026-07-29: Per-appearance-key generated art variant selection (`variantsByAppearanceKey`)

## Status

Accepted

## Date

2026-07-29

## Estimated Complexity

🍎🍎🍎🍎 — touches 2 systems (shared render-kind schema, `PhaserBridge` generated-texture
resolution), plus the sprite-pipeline art itself.

## Context

The player's `world.playerGender` field (`'female' | 'male' | 'other'`, default `'female'`)
already exists (set at intro, carried across floor transitions), but the renderer always
drew one fixed walk-cycle sheet (`rhea-vale-v1-var-0-walk`) regardless of gender. We
shipped three gender-matched 4-frame, 256×256 walk-cycle sheets
(`player-walk-cycle-{female,male,other}`) and needed a way for
`entity-sprite-mappings.json`'s `player` render kind to select the right one at runtime
from `world.playerGender`.

The `generated` block on a render kind previously supported exactly ONE static
descriptor: `{ briefId, pinnedTextureKey, scale }`. `resolveGeneratedTexture` in
`src/engine/PhaserBridge.ts` already threads an `appearanceKey` for ENEMIES, but that
path is registry-based: `pickGeneratedEnemyTextureKey` → `GENERATED_BRIEF_BY_TYPE` /
`GENERATED_BRIEF_BY_APPEARANCE_KEY` (`src/shared/generated-assets.ts`,
`src/engine/phaser-bridge/sprite-kind.ts`) — a global map keyed by enemy-type/appearance
strings, with variant-ROLL semantics (an enemy's variant is a pseudo-random pick among
several approved variants of the SAME underlying design). `'player'` is deliberately
absent from those tables.

## Decision

Add a small, self-contained `variantsByAppearanceKey` map **inside** the render kind's
own `generated` block (a new optional field on the existing type), rather than reusing
the enemy-appearance registry:

```ts
readonly generated?: {
  readonly briefId: string;
  readonly pinnedTextureKey: string;
  readonly scale: number;
  // Checked BEFORE the top-level fields above, keyed by resolveGeneratedTexture's
  // appearanceKey option.
  readonly variantsByAppearanceKey?: Readonly<
    Record<string, { briefId: string; pinnedTextureKey: string; scale?: number }>
  >;
};
```

`resolveGeneratedTexture` resolves an "effective" briefId/pinnedTextureKey/scale by
checking `generated.variantsByAppearanceKey?.[appearanceKey]` first, falling back to the
top-level descriptor if no entry matches — then runs the EXISTING
pinned→briefId→prefix-scan cascade against that effective descriptor. The
enemy-appearance registry lookup (`pickGeneratedEnemyTextureKey`) is untouched and still
only fires for enemy types present in `GENERATED_BRIEF_BY_TYPE`
/`GENERATED_BRIEF_BY_APPEARANCE_KEY` — `'player'` remains absent from those tables, so the
player always falls through to this new per-render-kind variant lookup.

The `appearanceKey` computation site in `PhaserBridge.ts`'s render-sync loop (previously
only set for `entityType === 'enemy'`, reading `world.enemyAppearanceKeys`) was extended
to also resolve `world.playerGender` for `entityType === 'player'`.

A one-time warning log (`warnGeneratedTextureUnresolved`, deduped per `type:appearanceKey`
combo) was added on the two silent-`null`-return paths in `resolveGeneratedTexture` — this
silence is exactly what let the original Rhea Vale regression (PR #2321) ship undetected.

## Consequences

### Positive

- Player gender selection is isolated to the player's own `generated` block — zero
  changes to the enemy variant-roll registry, zero risk of gender strings colliding with
  enemy appearance-key strings (verified no collision: none of `female`/`male`/`other`
  appear as keys in `GENERATED_BRIEF_BY_APPEARANCE_KEY`).
- The shape generalizes beyond the player: any render kind can now select a
  generated-art variant by an arbitrary `appearanceKey` string, without inventing a new
  per-feature mechanism each time (e.g. a future cosmetic-selection feature could reuse
  this same field).
- Top-level `briefId`/`pinnedTextureKey`/`scale` remain a safe default — a render kind
  with `variantsByAppearanceKey` but no match for a given key (or an `appearanceKey` of
  `undefined`) still resolves to _something_ rather than a hard null, preserving the
  existing all-null-silent-fallback safety net (now logged once instead of silent).
- No animation-registration code changes needed: `generatedAnimationByTexture` is already
  keyed by resolved texture key and populated generically from each entry's own
  `animation` field, so three separate shards "just work" for walk-cycle playback once
  wired.

### Negative

- A second appearance-key-like concept now exists in the codebase (registry-based for
  enemies, config-based for player/future render kinds) — a future reader has to learn
  both. Documented in both places with a comment cross-reference.
- `variantsByAppearanceKey` is NOT validated against a Zod/JSON-schema shape at data-load
  time (only via TypeScript's structural type on the `.json as EntitySpriteMappings` cast)
  — a typo in a variant key or briefId would silently fall through to the top-level
  default rather than fail fast. Mitigated by
  `tests/unit/entity-sprite-mapping-art-wiring.test.ts`, which deterministically asserts
  every configured `variantsByAppearanceKey` entry resolves against the real shipped
  manifest.

### Risks

- **Cross-SHEET proportion consistency is NOT deterministically gated.** The pipeline's
  `checkFrameCoherence` sensor only compares frames WITHIN one sheet (floor-line drift,
  scale drift, etc. across the 4 frames of e.g. the female sheet). It does NOT compare
  the female sheet's body proportions against the male or other sheet. All three were
  generated from the identical body/outfit/proportions prompt text and visually
  eyeballed at approval + real-game-observation time, but this is a SOFT guarantee, not a
  CI gate. **This matters most for the planned equipment-overlay system**: if any future
  regeneration of one gender's sheet drifts in scale/proportion relative to the other two
  (e.g. a re-roll of just the `male` sheet), overlay art authored against one gender's rig
  could misalign on the others with no test catching it. Flagged here and in the session
  handoff so the equipment-overlay work knows to either (a) add a cross-sheet coherence
  sensor before depending on pixel-exact rig alignment, or (b) re-verify alignment
  visually whenever any one gender's sheet is regenerated.

## Alternatives Considered

1. **Reuse the enemy `appearanceKey` registry** (`GENERATED_BRIEF_BY_APPEARANCE_KEY` /
   `pickGeneratedEnemyTextureKey`) for the player by adding `female`/`male`/`other` entries
   there. Rejected: that registry's semantics are variant-ROLL (a pseudo-random pick among
   several approved variants of the same design, selected by `variantRoll`), not a fixed
   per-entity selection. Gender is fixed per player session, not rolled — forcing it
   through the roll-based path would require either always passing `variantRoll = 0`
   (fragile, easy to regress if the roll logic ever changes) or adding gender-specific
   branches into enemy-only code, coupling two unrelated concepts (mob variant art director,
   player identity) in one shared table.
2. **A separate render kind per gender** (`player-female`, `player-male`, `player-other`),
   each with its own single-descriptor `generated` block, and have the ECS/renderer select
   the render kind itself based on `world.playerGender`. Rejected: this would require
   plumbing gender selection through `resolveTexture`'s `visualType` argument (currently
   derived purely from `entityType`/enemy-appearance, with no concept of "player identity"
   at that layer), duplicating every other player-specific render-kind field
   (`proceduralTexture`, `kenneySpriteId`, `kenneyScale`) three times for no benefit, and
   scattering "is this a player-gender variant" checks across every consumer of render
   kinds instead of containing the decision to one resolution function.
3. **A dedicated player-appearance registry, or a fully generic appearance-source
   abstraction** spanning both enemy variant-roll and player fixed-selection semantics
   under one unified system. Raised during the adversarial plan review (see addendum
   below) as the "genuinely different" third alternative, distinct from #1/#2 above.
   Rejected for THIS feature: the reviewer's own conclusion was that this
   generalization is not warranted to ship gender-matched walk cycles — it is only
   worth the redesign cost if/when a second consumer of appearance-key-based selection
   materializes (e.g. a future cosmetic/skin system). Revisit if that happens; do not
   speculatively build it now (Zero Cruft).

## Plan-Review Addendum (2026-07-30)

An adversarial plan review (separate model, `gpt-5.4`, high reasoning effort — see the
session's review ledger) red-teamed this design before implementation and returned
`approved_with_changes`. It confirmed alternatives 1 and 2 above were soundly rejected,
and surfaced alternative 3 (recorded above) as the one legitimately different
architecture — but explicitly judged it not warranted to ship this feature. Five
additional non-blocking concerns were raised and are addressed here rather than through
a design change, per the reviewer's own recommendation not to re-architect to ship:

- **`variantsByAppearanceKey` is schema-generic but not behavior-generic.** The field
  name and type are written as if any render kind could adopt per-appearance-key
  variants, but in practice only the player currently does, and the only appearance-key
  source wired up is `world.playerGender` (enemies use the separate registry path, see
  Decision above). This is an intentional scope choice, not an oversight: the field is
  reusable schema, not a claim that a second consumer already exists. Documented here so
  a future reader building a second consumer knows to verify the resolution semantics
  they need (fixed selection, like gender) match this path, rather than assuming a fully
  generalized appearance system already exists.
- **Resolution precedence** (enemy registry → per-appearance-key variant → top-level
  default) is now documented inline as a comment directly above the registry lookup in
  `resolveGeneratedTexture` (`src/engine/PhaserBridge.ts`), not just in this ADR, so it is
  visible at the point of the actual ordering decision.
- **`pinnedTextureKey` is not fail-closed.** If a pinned key is absent from loaded
  textures, resolution silently falls through to `briefId`/prefix-scan, which could in
  principle select an unexpected texture rather than failing loudly. Accepted as an
  existing, pre-existing behavior of `resolveGeneratedTexture` that this change does not
  alter or worsen (the same fallback existed before per-appearance-key variants were
  added) — the warning-log fix in this same change (logging the effective, resolved
  descriptor rather than the top-level one) makes any such fallback observable in logs,
  which was the actionable part of this concern. A fail-closed mode for the player
  specifically is out of scope for this change; flagged for a future hardening pass if a
  pin-miss is ever observed in practice.
- **Dual source of truth for the player's default variant** (`generated`'s top-level
  `briefId`/`pinnedTextureKey`/`scale` currently duplicate the `female` entry in
  `variantsByAppearanceKey`, since `world.playerGender` defaults to `'female'`). Accepted
  as a documented drift risk rather than reworked into an exhaustive compile-time-checked
  map: `tests/unit/entity-sprite-mapping-art-wiring.test.ts` deterministically asserts all
  three gender variants resolve correctly against the shipped manifest, which would catch
  the top-level default silently drifting out of sync with the `female` variant in a way
  that broke resolution (not merely duplicated text). A stricter exhaustive-map schema is
  a reasonable follow-up if a fourth appearance key or a second player-appearance-selected
  field is ever added.
- **Cross-sheet proportion consistency remains an explicitly un-gated soft guarantee**
  (see Risks above) — the reviewer agreed a deterministic cross-sheet sensor should NOT
  block this feature, but should be built before the planned equipment-overlay system
  depends on pixel-exact rig alignment across genders. No change made here beyond what
  was already documented in the Risks section.
