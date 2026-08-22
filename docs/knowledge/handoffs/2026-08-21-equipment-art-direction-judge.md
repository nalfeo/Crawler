# Equipment art-direction judge

## Systems touched

inventory, azure-infra, ci-policy

## What changed

- Added an advisory-only Azure Vision batch judge for the eight archived neutral
  Equipment screenshots (`v0.1.0` through `v0.1.7`).
- Grounded nine art-direction pillars in the inventory UX lookbook: identity,
  icon vocabulary, palette/material grammar, semantic color integrity, focal
  hierarchy, density/rhythm, delta storytelling, genre fluency, and delight.
- Kept the historical runner separate from the live visual-review gate so it
  cannot recapture, score, or block the legacy pipeline.
- Hardened the response validator across every free-text field. Neutral-state
  counterfactuals and unsupported Bag-color semantics are rejected, with up to
  two corrective provider retries per screenshot.

## Evidence

- Azure batch artifact:
  `files/visual-review/equipment-art-direction-batch.json`.
- All eight final reports completed with no failed captures.
- The recurring visual diagnoses are a flat Stats hierarchy and inconsistent
  Bag-to-equipment icon vocabulary. The reports do not treat the intentionally
  absent candidate/preview state or unspecified Bag border colors as defects.

## Verification

- `node --test scripts/agent/review/equipment-art-direction-lib.test.mjs`
- `npm run typecheck`
- `npm run verify:fast`

## Follow-up

The reports are session-local evidence, not CI gates. Use the existing
deterministic visual checks for shipping geometry and state correctness; use
this judge to prioritize art-direction iterations.
