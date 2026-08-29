# Handoff — Spell stat row overflow + summary coverage (PR #3874 shepherd)

## Systems touched

ability-loadout-ui, progression-abilities

## Context

Shepherd session for PR #3874 ("Show range/damage numbers on every spell picker").
The PR adds a derived stat line (`Damage 15 • Target & blast radius 12 ft • …`)
to every spell picker row. Three Copilot review threads were unresolved; this
session addressed all three, resolved them, and handed the PR to the merge train.

## What changed

### 1. Ability rows now size to their measured content (`src/engine/AbilityLoadoutUI.ts`)

The new stat line pushes each row's description down
(`descriptionY = max(rowY + 76, details.y + details.height + 4)`), but rows were
still drawn at a fixed `ROW_HEIGHT = 102`. A wrapped stat line or a two-line
description therefore rendered **past the row edge and over the row below**.

Fix mirrors the `fitContent()` two-pass growth pattern `ModalPickerUI` already
uses in this same PR:

- `ROW_HEIGHT` → `MIN_ROW_HEIGHT` (102) + `ROW_CONTENT_PADDING` (11) +
  `NOMINAL_LIST_HEIGHT`.
- Row content (`tile`/`identity`/`name`/`details`/`description`/`action`) is now
  created **before** the row background rectangle, so the rect can be sized to
  `max(MIN_ROW_HEIGHT, ceil(description.y + description.height + padding - rowY))`.
  Creating the rect last also keeps `setInteractive()` — which snapshots its hit
  area from the current size — consistent with the final geometry.
- Row positioning moved from `localIndex * (ROW_HEIGHT + ROW_GAP)` to a `cursorY`
  accumulator, which also absorbs the passive-section header offset.
- `layoutPanel()` extracted from `render()`; `fitListContent()` grows
  `panelHeight`/`listViewportHeight`, recomputes `uiScale`/`effectiveResolution`,
  re-centres the panel, and shifts already-created objects by the delta.
- Probe bounds (`rowBounds`/`rowLayouts`) are now built **after** the fit pass
  from live object positions, so they reflect the final scale rather than the
  first-pass guess.

Nothing is clipped or truncated — the panel grows and `fitUiScale` absorbs it.

### 2. Spell summary coverage derives from the catalog (`tests/unit/spell-effect-summary.test.ts`)

`effectTargetsOtherEntities` / `effectDamagesOtherEntities` were hand-maintained
`effect.type === '…' || …` chains. Because `summarizeEffect()` has a
`default: return []` arm, a newly added `spell_*` variant would produce **no
summary at all** while both predicates returned `false` — the suite passed
silently.

Replaced with:

- `EFFECT_BEHAVIOUR: Record<CatalogEffect['type'], { targetsOthers, damagesOthers }>`
  — exhaustive, so a new union member is a **compile error**.
- `SPELL_EFFECT_SAMPLES: { [K in SpellEffectType]: Extract<CatalogEffect, { type: K }> }`
  — one representative effect per spell type, also exhaustive.
- A new test that runs every sample through `formatSpellEffectSummary` and
  asserts a non-empty summary plus reach/damage per the behaviour table. The
  formatter's silent `default` arm is now a failing test.

### 3. Review ledger regraded against the current head

`docs/knowledge/review-ledgers/2026-08-27-spell-effect-numbers.review-ledger.json`
pinned `independent_grade.head_sha` to a commit that predated substantive
changes. Re-run via `npm run review:grade` against the final head.

## Observe before done

Real artifact: `main-scene-probe-lab` rendering the real `MainGameScene`
`AbilityLoadoutUI`, driven by `tests/e2e/main-game-scene-ui-exclusivity.test.ts`
at both 1280x720 and 960x540.

- **Before** (fix reverted, new assertions kept): `fireball description overflows
its row: expected 333.9 to be less than or equal to 317.52` — **16.4 px of
  overflow at both viewports**.
- **After**: both viewports pass.

The regression is now covered deterministically: every visible row asserts
`details`/`description` bottom ≤ row bottom, plus row-to-row non-overlap.

## Verification

- `npm run verify:fast` — pass.
- `npx vitest run tests/unit/spell-effect-summary.test.ts --project unit` — 14 pass.
- `npx vitest run tests/e2e/main-game-scene-ui-exclusivity.test.ts --project e2e -t 'keeps spell stats separated'` — 2 pass.
- `bash scripts/agent/lab-gate-check.sh` **not** run locally (Windows; CI enforces it).

## Gotchas for the next session

- The e2e `page.goto` can time out on the **first** navigation after a source
  edit while Vite re-transforms; it is not a product failure. Re-run once the
  cache is warm before investigating.
- `fitListContent()` must run **after** the row loop but **before** the scroll
  hint and footer text, since both are anchored to the final `panelY` /
  `footerBounds()`.
- `dynamic` is typed `GameObject[]`, which has no `x`/`y`; the shift loop casts
  to `GameObject & Components.Transform`.
