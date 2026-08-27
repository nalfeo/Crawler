# ADR: Spell stat lines are derived from the ability registry, not authored twice

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 3 — one new pure `src/shared/` formatter plus a `src/game/` lookup, four
presentation surfaces rewired, and one latent `src/engine/` modal-layout bug that
the extra description line exposed.

## Context

Issue #3671: every surface where the player _chooses_ a spell showed prose only.
The boss-reward "Learn a Spell" modal, the Spell Broker offer list, the abilities
config modal (`[B]`), and the abilities lab tooltip all rendered
`ABILITY_PRESENTATION[id].description` — evocative text with no damage, no reach,
no duration. A player picking between `fireball` and `magic-missile` had no way
to compare them without reading `src/game/abilities/registry.ts`.

The numbers already exist, authored once, in that registry as `CatalogEffect[]`
(`spell_fireball`, `spell_magic_missile`, `spell_heal`, `spell_timed_buff`, …). Two ways to get
them in front of the player:

1. **Author a second `stats:` string per spell** in `ability-presentation.ts`.
   Simple, fully controllable copy — and guaranteed to silently drift the first
   time anyone retunes a spell, because nothing links the two.
2. **Derive the line from the effect values at read time.** One source of truth;
   a retune updates the UI for free. Costs a formatter that must understand every
   effect shape, and must not lie about what the number means.

We chose (2). Drift on gameplay numbers is exactly the failure this repo keeps
paying for, and a derived line is testable against the registry itself.

Two honesty problems fell out of the plan review and shaped the format:

- The registry values are **base** values. `resolveSpellOutput` multiplies them
  by INT scaling _and_ a spell-mastery efficacy multiplier, so a bare "Damage 15"
  is wrong for any player who is not at base. Every summary therefore ends with
  an explicit `Base — scales with INT & mastery` (or `… with mastery` for effects
  with no INT term).
- `fireball.radiusTiles` is **both** the targeting reach and the blast radius —
  the epicenter is picked from enemies within it. Labelling it "Radius" would
  read as blast-only, so it renders as `Target & blast radius`.

## Decision

`src/shared/spell-effect-summary.ts` exports a pure
`formatSpellEffectSummary(effects, { tileSizeFt })` that turns `CatalogEffect[]`
into a `•`-joined stat line, converting tiles to feet with the live
`floorMap.config.tileSizeFt` (default 4). `src/game/abilities/effect-summary.ts`
resolves an ability id through `getAbilityDefinition` and delegates. Passive
abilities and unknown ids return `undefined`, so no caller has to special-case.

Four surfaces consume it:

- `getBossRewardSpellOptions` (`src/game/floorScenario.ts`) emits
  `prose\nstats` as the option description.
- `MainGameScene` gets the summary through a **scene option callback**
  (`getAbilityEffectSummary`), wired in `src/bootstrap/floor-main-scene-options.ts`.
  The engine layer must not import `src/game/`, and this keeps the ESLint layer
  rule intact instead of reaching across it.
- The abilities lab tooltip appends the same line.

`src/engine/ModalPickerUI.ts` was authored with a **fixed 400px panel** and no
content fit, so the added second description line rendered outside the panel — a
latent bug any longer description would have hit. The panel now measures its
real content and grows to it in a second pass (`fitContent`), re-deriving
`uiScale` and shifting the already-created nodes by the panel-origin delta. Text
heights are only measurable after creation in Phaser, hence the second pass
rather than a pre-computation. The description wrap width is now tied to the same
`ENTRY_TEXT_INDENT` constant as the description's x offset, which previously
disagreed by 2px and let a full-width line spill past its row.

## Consequences

- Retuning a spell in the registry updates every picker automatically; there is
  no second string to forget.
- `tests/unit/spell-effect-summary.test.ts` asserts the **exact** string for each
  Floor-1 boss-reward spell and loops the registry to require that spells which
  reach another entity state a reach number and spells which damage another
  entity state damage, so a new effect type cannot ship a blank line.
- The modal picker is now variable-height for **all** callers, not just spells.
  `tests/e2e/boss-reward-picker-ux.test.ts` measures the real `MainGameScene`
  modal at 1280x720 and 960x540 and asserts every box stays inside the panel and
  no two boxes overlap, so a future overflow is caught deterministically.
- Displayed numbers are base values, explicitly labelled as such. If we later
  want live per-player values, the formatter takes an options object and can
  accept a resolved-stat context without changing its callers' shape.

## Alternatives considered

- **Hand-authored `stats:` strings** — rejected for guaranteed drift (above).
- **Importing the registry directly into `MainGameScene`** — rejected: it
  violates the `src/engine/` → `src/game/` layer rule, which
  `tests/unit/spell-stat-detail-wiring.test.ts` now guards explicitly.
- **Shrinking the font / truncating to fit the fixed panel** — rejected: it hides
  the very numbers the issue asks for, and leaves the latent overflow in place
  for the next caller.
