# Handoff: crabfolk-elite-shell-capo asset request

## Date

2026-08-01

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

Estimated 1🍎, actual 1🍎 — pure art brief creation, no code changes.

## Summary

- Added enemy brief at `briefs/enemies/crabfolk-elite-shell-capo-v3.yaml` for
  issue nalfeo/Crawler#2560.
- The brief encodes the requested elite crabfolk capo: wide/low-center tank
  silhouette, oversized reinforced shell with pinstripe paint and gold trim,
  cigar clamped in one armored claw, fine suit jacket draped over one shoulder,
  thick gold chains, both claws visibly armored with riveted chitin plating.
  Matches the crabfolk family's blue-gray shell tones with gold elite accent.
- Declared `mobRole: elite` (schema-valid; sits between `normal` and `boss`).
- No `sizeVariant` — default footprint appropriate for elite (not boss-wide).
- Used `sensors.enemy.facing: front` — enforces the front-facing silhouette spec.
  (`toleranceDeg` is only honoured for `type: character` briefs; enemy facing is
  validated by the judge prompt and VLM evaluation instead.)
- `sensors.edge.allowMainTouch` left at the enemy default (`false`) — enforces that
  the largest opaque component does not clip the frame edge, matching the stated edge
  containment intent.
- `judge.enabled: true, maxVariants: 4` — VLM judge active, 4 candidates to be
  scored on next generation run.
- Seeded 4 distinct variations covering: direct front-facing authority pose,
  wide silhouette emphasis, cold authority with raised warning claw, and the
  full cartel presence read at a glance.

## Validation

- Python field validation ✅
  - All required fields present: `type: enemy`, `mobRole: elite`,
    `name: crabfolk-elite-shell-capo-v3`, `floor: 2`, no `sizeVariant`,
    `sensors.enemy.facing: front`, `judge.enabled: true`,
    `judge.maxVariants: 4`, `minVariations: 4`, 4 variation entries.
- Pipeline execution ✅ — Issue #2560 was labeled `asset-request`;
  `asset-request.yml` workflow fired and **completed** (run `2026-08-01T05-40-09-030d5b08`):
  - Synthesized brief `crabfolk-elite-shell-capo-v3` (GPT-4o selected candidate 3/3)
  - 4 variants generated; 3 selected (each with 1 sensor failure — accepted by judge); 1 candidate rejected
  - Canonical brief renamed to `v3` to match the generated lineage

## Blockers / notes

- Repo dependencies (`node_modules`) are not installed in this sandbox;
  `tsx` is unavailable so the schema-level CLI validator could not be run in
  isolation. Python field-by-field validation was used as a substitute.
- Because the `asset-request.yml` workflow fires on the issue label (already
  applied on #2560), sprite generation should begin without a manual trigger.

## Next steps

1. Review the generated variants posted to issue #2560 (run `2026-08-01T05-40-09-030d5b08`).
   `asset-request.yml` already ran `Publish selected variants` automatically via
   `asset-request-publisher.ts`; confirm the 3 selected variants were approved and
   the canonical `assets/queue` PR was opened by the publisher step.
2. After the art-only `assets/promote → main` PR merges, wire into
   `entity-sprite-mappings.json` via
   `npm run sprites:generate-wiring -- --since main`.
