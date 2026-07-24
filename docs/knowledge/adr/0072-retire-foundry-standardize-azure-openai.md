# ADR 0072: Retire Foundry — Standardize Asset Pipeline on Azure OpenAI

## Status

Accepted (2026-07-24). Supersedes ADR 0033.

## Date

2026-07-24

## Estimated Complexity

🍎 x 2 — tooling-only change; removes dead provider code and setup scripts.

## Context

ADR 0033 introduced an Azure AI Foundry (AIServices) backend as a parallel
content-generation path alongside the existing direct Azure OpenAI provider.
The intent was an incremental migration. However:

- The Foundry backend was never promoted to the default (`SPRITES_PROVIDER` remained
  `azure-openai`).
- All CI and production sprite runs have used `azure-openai` exclusively.
- The Foundry code path added complexity without delivering a measurable benefit.
- The `foundry` provider backend was never wired into the asset-request workflow
  (`asset-request.yml`) — that workflow standardized on `azure-openai` directly.

The CI recovery loop (PR #1886) identified four review findings:
1. Dead `createFoundry*Provider` functions in `factory.ts` that added build risk.
2. Incomplete `-IncludeFoundry` parameter removal from `setup-azure-env.ps1`.
3. `imageProviderIsAzureOpenAi` logic was inverted (treated `foundry` as Azure OpenAI).
4. Test coverage for the inverted bootstrap logic was missing.

## Decision

Retire the `foundry` provider backend entirely:

1. Remove all `foundry` branches from `scripts/sprites/provider/factory.ts`.
   `SUPPORTED_BACKENDS` is now `['azure-openai', 'local-a1111']`.
2. Update `imageProviderIsAzureOpenAi` in `env-bootstrap.ts` to return `true` for
   any backend that is not `local-a1111` (rather than checking `!== 'foundry'`).
3. Remove `-IncludeFoundry` and all foundry parameters from `setup-azure-env.ps1`
   and `setup-azure-resources.ps1`.
4. Remove the `Ensure-AIFoundryAccount` function and `$IncludeFoundry` provisioning
   block from `setup-azure-resources.ps1`.
5. Remove `aif-crawler-nalfeo` and `rg-crawler-foundry` from `PersistentResourceNames`.
6. Mark `scripts/azure-foundry-plan.ps1` as ARCHIVED (kept for reference only).
7. Remove all foundry assertions from `setup-azure-resources.tests.ps1`.
8. Update `factory.test.ts` to verify that setting `SPRITES_PROVIDER=foundry` now
   throws an unknown-backend error.

## Consequences

- The asset pipeline has a single, well-tested code path: Azure OpenAI.
- Developer setup is simpler; no foundry resource group or AIServices account needed.
- `SPRITES_PROVIDER=foundry` in `.env.local` will now fail fast with a clear
  "unknown backend" error, guiding users to use `azure-openai` or `local-a1111`.
- `scripts/azure-foundry-plan.ps1` is archived and no longer dot-sourced.

## Systems Touched

sprite-pipeline, azure-setup
