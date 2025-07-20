# Floor 2 Boss Regeneration

## Summary

Added an optional `default` / `large` / `wide` / `tall` Size field to the
owner-gated asset-request issue workflow. Explicit sizes flow through parsing,
fingerprints, ingester state, Azure queue messages, synthesis, and generation.
Canonical boss requests default to `large` only when Size is omitted; explicit
sizes always win and ordinary enemies remain default-sized.

Legacy issue bodies, fingerprints, claim/status keys, and queued messages remain
readable. Invalid explicit issue or persisted queue sizes now emit clear,
issue/message-specific diagnostics without poisoning the full issue sweep or
worker loop.

## Systems touched

sprite-pipeline, sprite-workflow

## Persona routing

- Producer coordinated the code, review, merge, and post-merge generation order.
- Graphics/AI content concerns stayed inside the existing sprite synthesis and
  size-variant architecture.
- QA coverage focused on issue parsing, identity compatibility, queue reload,
  pipeline forwarding, and generated geometry.

## Key decisions

- Omitted-size fingerprints remain byte-stable, including boss requests, so old
  claims and status documents do not need migration.
- New requests persist the effective size. Pipeline-time boss inference runs only
  for legacy queue messages that lack the field.
- Boss inference uses the canonical terminal `-boss` slug, or an explicit
  `enemy` request whose brief contains a standalone boss/godfather cue. Explicit
  non-enemy types suppress inference.
- Explicit invalid sizes fail validation; unrendered GitHub template expressions
  remain eligible for the existing rendered-form fallback.

## Geometry contract

| Size    | Output  | Sheet grid | 1024px cell |
| ------- | ------- | ---------- | ----------- |
| `large` | 128x128 | 2x2        | 512x512     |
| `wide`  | 128x64  | 4x2        | 512x256     |
| `tall`  | 64x128  | 2x4        | 256x512     |

## Review

5-apple adversarial plan review considered explicit-only sizing,
ingestion-only resolution, and a versioned identity migration. Two correctness
rounds and two distinct-model review rounds ended clean after fixing legacy tile
false positives, marker fallback, malformed-issue sweep isolation, and invalid
queue-message handling.

Ledger:
`docs/knowledge/review-ledgers/2026-07-16-floor2-boss-regeneration.review-ledger.json`

## Verification

- `npm run verify:fast`
- Focused sprite unit suites: 1176 tests passed
- Review ledger validation

## Apples

5 estimated, 5 actual (exact). The change spanned issue intake, identity,
persistence, generation, tests, review, merge sequencing, and post-merge CI
generation as expected.

## Follow-up

After this support reaches `main`, file the five Floor 2 boss asset requests and
observe the credentialed `asset-request.yml` runs through generated review
artifacts before any approval/check-in decision.
