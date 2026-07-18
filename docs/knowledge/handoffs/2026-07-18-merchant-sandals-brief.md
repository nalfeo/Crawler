# Handoff: Add merchant-sandals sprite brief for Floor 2 equipment

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 exact (brief authoring only — art lane, review-ledger exempt)

## What Was Done

- Added `briefs/items/merchant-sandals.yaml` as the committed source brief for
  the Floor 2 feet-slot equipment icon request.
- Kept the runtime identity exact at `name: merchant-sandals`, matching the
  issue's stable/runtime key suffix and avoiding a versioned brief id.
- Authored the prompt around one compact, centered sandals icon on a transparent
  background with a silhouette that reads as rugged merchant footwear rather
  than boots, slippers, or bare feet.
- Added three focused variations covering darker leather, coin-tag/merchant
  trim, and a heavier armored travel-sandal silhouette.

## Key Decisions Made

1. **Brief-only change** — this session adds the source brief, not generated PNG
   approvals or runtime wiring. The current environment does not provide an
   authenticated issue-comment path or asset-generation approval flow.
2. **Floor 2 material language** — the brief uses worn leather plus tarnished
   brass/coin details so the icon reads as Floor 2 salvage-merchant gear.
3. **Exact bare identity** — using `merchant-sandals` preserves the requested
   runtime-key suffix and matches the issue's explicit "preserve the runtime key
   exactly" requirement.

## Verification

- `npx tsx -e "import { loadBrief } from './scripts/sprites/load-brief.ts'; ..."`
  loaded and validated `briefs/items/merchant-sandals.yaml` successfully.
- `npm run verify:fast`

## Follow-up / Blockers

- The requested issue-plan comment could not be posted from this environment
  because the available GitHub CLI token is invalid here and no direct issue
  comment creation tool is exposed in-session.
- Generating, judging, approving, and checking in the actual merchant-sandals
  PNG remains follow-up work once the asset-request workflow or an authenticated
  sprite pipeline path is available.
