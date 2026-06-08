# Handoff — DevTools UX for floor art tracking

## What landed

Added a dedicated DevTools interface to inspect floor/theme art plan progress
against placeholders, briefs, approvals, and integration wiring.

## UX surface

- Entry point remains `devtools.html` / `src/devtools-main.ts`.
- DevTools now renders:
  - plan selector (`plans/floor-art/*.art.yaml`)
  - status filter + text search
  - summary cards (assets, unresolved placeholders, ready, needs-art, etc.)
  - detailed asset table with lifecycle status and integration context
  - manifest refresh action

## Data model

- New shared browser-safe model at `src/devtools/art-plan-model.ts`:
  - parses art plans from YAML
  - parses committed brief keys from `briefs/**/*.yaml`
  - parses generated asset manifest entries
  - computes lifecycle status per asset:
    - `ready`
    - `approved`
    - `approved-not-integrated`
    - `approved-missing-file`
    - `brief-ready`
    - `brief-ready-placeholder`
    - `needs-art-placeholder`
    - `planned`

## Validation added

- `tests/unit/devtools-art-plan-model.test.ts` covers:
  - plan parsing
  - brief/approval parsing
  - status derivation across lifecycle axes

## Notes

- DevTools remains localhost-only.
- Manifest is fetched from `/assets/generated/manifest.json`; if unavailable,
  UI still renders and reports manifest-unavailable state.
