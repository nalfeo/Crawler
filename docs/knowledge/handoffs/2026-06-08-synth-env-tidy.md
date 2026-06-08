# Handoff: synth respects minVariations + chat deployment fallback

**Date:** 2026-06-08
**Branch:** `nalfeo/synth-minvariations-env-tidy`
**Persona:** graphics-designer

## Summary

Small housekeeping bundle off `main`. Two unrelated tidy-ups in one PR.

### 1. synth respects `minVariations`

`scripts/sprites/synthesize-brief.ts` previously capped `embellishmentSeeds`
at 3–5 entries via static `MIN_SEEDS_PER_CANDIDATE` / `MAX_SEEDS_PER_CANDIDATE`
constants. Sprite-type files (`data/sprite-types/weapon.json` etc.) inherit
`minVariations: 4` from `briefSchema`'s default. When synth produced 3 seeds
for a weapon brief, the downstream expander had to invent a 4th from thin air
(visible as `expand-variations: text provider not configured`).

Now synth:

- Loads each sprite-type's effective `minVariations` (new
  `defaultLoadMinVariations` reads `data/sprite-types/<type>.json` and falls
  back to the schema default of 4 when the file or field is missing).
- Computes `effectiveMinSeeds = max(MIN_SEEDS_PER_CANDIDATE, minVariations)`
  and `effectiveMaxSeeds = max(MAX_SEEDS_PER_CANDIDATE, effectiveMinSeeds)`.
- Passes the effective range into the system prompt via two new fields on
  `SynthesizeBriefRequest` (`effectiveMinSeeds`, `effectiveMaxSeeds`).
- Validates LLM responses against the effective min, not the static constant.
- Re-derives bounds against the inferred type when `--type` is not supplied
  on the CLI (picks the max minVariations across all SPRITE_TYPES for the
  initial prompt, then re-checks against the inferred type at validation).

### 2. Chat / vision deployment fallback

`scripts/sprites/provider/factory.ts` now falls back from
`AZURE_OPENAI_CHAT_DEPLOYMENT` to `AZURE_OPENAI_VISION_DEPLOYMENT` when the
chat var is missing but the vision var is present. They're typically the
same deployment on Azure OpenAI accounts.

- `resolveChatDeployment` helper performs the fallback and warns once per
  deployment name via a module-level `warnedFallbackDeployments` Set.
- `createTextProvider` and `createSynthProvider` both use the resolver.
- `createSynthProvider` throws a clear error when neither var is set.
- Tests can reset the warn dedup via `__resetChatDeploymentFallbackWarnings`.
- Documented in `docs/agent-os/sprite-style.md` env section.

## Files touched

- `scripts/sprites/provider/synth-types.ts` — new `effectiveMin/MaxSeeds` fields.
- `scripts/sprites/provider/azure-chat-synth.ts` — prompt uses effective range.
- `scripts/sprites/synthesize-brief.ts` — effective-bounds resolution +
  `loadMinVariations` option.
- `scripts/sprites/provider/factory.ts` — chat/vision deployment fallback.
- `tests/unit/sprites/synthesize-brief.test.ts` — `makeCandidate` updated to
  4 seeds; new tests for the minVariations behaviour.
- `tests/unit/sprites/factory.test.ts` — NEW, 7 tests covering the fallback.
- `docs/agent-os/sprite-style.md` — env alias note.

## Verification

- `npm run verify:fast` ✅ (86 test files, 853 tests)
- `npx tsc --noEmit` ✅
- `npx prettier --write .` ✅ (only touched files in this PR)

## Follow-ups

None — both tidy-ups are self-contained.
