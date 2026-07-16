# Revise Content Prompts

## Summary

Replaced generic sprite-generation direction with Crawler's authored dark-fantasy,
industrial-salvage, absurdist design language. Added a Floor 1-20 intensity contract
across brief synthesis, generation, selection, judging, issue intake, queues, and
sidecar APIs while preserving omitted Floor 1 YAML and legacy Floor 1 fingerprints.

The visual judge now scores Crawler design language and reference rendering style
separately, alongside brief match and readability. Legacy `style_match` payloads and
stored summaries remain readable, and devtools exposes the expanded scorecard.

## Files Touched

- Sprite prompt, synthesis, provider, judge, cache, schema, CLI, and request pipeline code under `scripts/sprites/`
- Devtools judge models and rendering under `src/devtools-main.ts` and `src/devtools/sprite-workflow-queue.ts`
- Sprite style, issue form, and achievement guidance
- Targeted unit and integration tests
- Three-apple review ledger

## Verification

- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-16-inventory-content-prompts.review-ledger.json`
- Two-round independent code review, ending clean

## Unresolved Issues

None.

## Recommended Next Steps

Review generated assets across several floor bands after merge and tune the shared
design-language or floor guidance centrally if production outputs reveal drift.
