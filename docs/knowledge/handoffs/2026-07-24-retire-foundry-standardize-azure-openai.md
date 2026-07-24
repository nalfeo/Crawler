# Handoff: Retire Foundry Backend — Standardize Asset Pipeline on Azure OpenAI

**Date:** 2026-07-24
**Session slug:** retire-foundry-standardize-azure-openai
**Apple estimate:** 2🍎 (tooling-only; cap applies)
**Issue:** nalfeo/Crawler#1885
**ADR:** [0072](../adr/0072-retire-foundry-standardize-azure-openai.md) supersedes [0033](../adr/0033-azure-foundry-content-generation.md)

## Systems touched

sprites, ci, infra

## Problem

The `foundry` provider backend (ADR 0033) was causing active CI failures:
- `aif-crawler-nalfeo` has zero deployments — no Foundry quota was obtainable.
- `FOUNDRY_*` CI secrets were repointed at the plain Azure OpenAI account, making the
  "foundry backend" a misnomer with a parallel code path.
- `FOUNDRY_BRIEF_SELECTOR_MODEL` fell back to `gpt-5-mini`, which rejects `max_tokens`
  and `temperature` parameters → every CI generation returned 400 and was dropped.
- Result: 8/8 fresh generations were dropped per run.

## What changed

### `.github/workflows/asset-request.yml`
- **Drain step**: replaced `FOUNDRY_*` env vars and `SPRITES_PROVIDER: foundry` /
  `SPRITES_TEXT_PROVIDER: foundry` / `SPRITES_SYNTH_PROVIDER: foundry` /
  `SPRITES_VISION_PROVIDER: foundry` with the `AZURE_OPENAI_*` secret references.
  No `SPRITES_*_PROVIDER` override needed — `azure-openai` is the default.

### `scripts/sprites/provider/factory.ts`
- Removed the `foundry` branch from `createImageProvider`, `createTextProvider`,
  `createVisionProvider`, `createSynthProvider`, `createBriefSelectorProvider`.
- Removed `foundryConnection`, `createFoundryImageProvider`, `createFoundryChatProvider`,
  `createFoundryVisionProvider` internal functions.
- Removed `foundry` from `SUPPORTED_BACKENDS` (now `['azure-openai', 'local-a1111']`).
- Updated module doc comment to reflect the retirement.
- `createSynthProvider` no longer calls `resolveBackend` — directly uses azure-openai path.

### `tests/unit/sprites/factory.test.ts`
- Removed the `foundry backend (ADR 0033)` describe block (8 tests).
- Removed the `foundry starter catalog (setup-azure-env.ps1 contract)` describe block (2 tests).
- Added `unknown backend rejection` describe block with 3 tests verifying `foundry` is
  now rejected as an unknown backend for `SPRITES_PROVIDER`, `SPRITES_TEXT_PROVIDER`,
  and `SPRITES_VISION_PROVIDER`.

### `scripts/sprites/provider/azure-chat-synth.ts`
- Updated `providerLabelPrefix` doc comment to remove the foundry-specific mention.

### `scripts/sprites/sidecar/env-bootstrap.ts`
- `imageProviderIsAzureOpenAi`: now checks `which !== 'local-a1111'` instead of
  `which !== 'foundry'`, correctly reflecting that `local-a1111` is the only non-azure
  image backend remaining.

### PowerShell scripts (archived foundry path)
- **`scripts/azure-foundry-plan.ps1`**: Added ARCHIVED header; functions kept for reference.
- **`scripts/setup-azure-env.ps1`**: Removed `-IncludeFoundry` switch, Foundry params,
  dot-source of `azure-foundry-plan.ps1`, FOUNDRY_* .env.local block, and FOUNDRY_*
  secret sync. The `AZURE_OPENAI_*` env file generation path is unchanged.
- **`scripts/setup-azure-resources.ps1`**: Removed `-IncludeFoundry` switch, Foundry
  params, dot-source of `azure-foundry-plan.ps1`, and foundry provisioning block.
  Removed `aif-crawler-nalfeo` and `rg-crawler-foundry` from `PersistentResourceNames`.
- **`scripts/setup-azure-resources.tests.ps1`**: Removed 36 foundry-related assertions
  (Get-FoundryDeploymentPlan, Format-FoundryEnvBlock, Get-FoundrySecretNames,
  setup-azure-env.ps1 contract, foundry resource persistence checks). Remaining 18
  assertions cover `Resolve-ResourceAction`, `Test-IsPersistentResource`, `Assert-NotBlocked`.

### ADR / docs
- **`docs/knowledge/adr/0033-azure-foundry-content-generation.md`**: Marked Superseded.
- **`docs/knowledge/adr/0072-retire-foundry-standardize-azure-openai.md`**: New ADR with
  full evidence and rationale.
- **`docs/knowledge/adr/README.md`**: ADR 0033 updated to Superseded; ADR 0072 added.

## What was NOT changed

- Provider interfaces (`ImageProvider`, `TextProvider`, etc.) — seam is intact.
- `local-a1111` backend — still available for local Stable Diffusion.
- `azure-foundry-plan.ps1` functions — kept as archived reference.
- The `aif-crawler-nalfeo` Azure resource itself — left as empty/inactive infra.
- Brief-selector prompt, synth/judge logic, orchestrator, sensors.

## Next steps

1. Remove `FOUNDRY_*` GitHub secrets from `nalfeo/Crawler` repository settings
   (Settings → Secrets → Actions) once the next drain run confirms the azure-openai
   path generates real art.
2. After a successful live run: update the ingest step comment in `asset-request.yml`
   to drop the historical "No FOUNDRY_* here on purpose" note.
3. Consider decommissioning `aif-crawler-nalfeo` in Azure if quota never becomes
   available (revisit if Azure AI Foundry quota opens up).
