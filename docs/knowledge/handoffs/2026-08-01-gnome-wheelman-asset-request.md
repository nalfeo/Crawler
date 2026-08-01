# Handoff: gnome-wheelman asset request

## Date

2026-08-01

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

2🍎 exact — a small asset-request brief addition plus focused loader coverage.

## What Was Done

Handled issue #2513 by taking the smallest repo change that matches the current
asset-request pipeline state:

- Added the committed source brief `briefs/enemies/gnome-wheelman.yaml` for the
  Floor 2 Cog Combine wheelman.
- Kept the change brief-only: no runtime enemy data, generated-asset mappings,
  or shipped PNG/manifests changed in this session.
- Added `tests/unit/sprites/gnome-wheelman-brief.test.ts` to verify the new
  brief loads through the real brief loader with the expected Floor 2 enemy
  defaults and key subject cues (`one-wheeled contraption`, `oversized wrench`).

## Key Decisions Made

1. **Brief-first instead of wiring churn**: repo inspection showed
   `gnome-wheelman` already exists in Floor 2 enemy data but currently resolves
   to shared `gnome-tinker` generated art. The smallest correct repo change for
   this issue was to add the canonical authored brief first.
2. **No generated-art mutation in this sandbox**: this environment does not have
   the required GitHub/Azure write path to complete the full generate → approve
   → checkin loop, so I did not fabricate placeholder art or weaken the normal
   pipeline.
3. **Focused regression coverage**: used the existing `loadBrief()` test pattern
   rather than broader sprite-pipeline integration churn.

## Verification

- `npx vitest run tests/unit/sprites/gnome-wheelman-brief.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-01-gnome-wheelman-asset-request.review-ledger.json`

## What's Next / Blockers

- I attempted to post the required pre-code plan comment directly on issue
  #2513, but GitHub comment creation is blocked in this environment (`gh issue
  comment` returned HTTP 403 GraphQL forbidden even with the provided token).
  The exact plan text was preserved in-session instead.
- To complete the full asset lane, a follow-up environment with the normal
  asset-request GitHub/Azure permissions should generate, judge, approve, and
  check in dedicated `gnome-wheelman` art, then repoint any runtime mapping from
  `gnome-tinker` to `gnome-wheelman` if/when new approved art lands.
