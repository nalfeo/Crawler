# Handoff: Retire Foundry Backend — Standardize Asset Pipeline on Azure OpenAI

## Date

2026-07-24

## Session slug

retire-foundry-standardize-azure-openai

## Summary

Retired the Azure AI Foundry (ADR 0033) provider backend from the asset pipeline
and standardized on Azure OpenAI. Also fixed a CI recovery loop regression where
`conflict-or-train-short-circuit` released stale automation locks without filing
a deduplicated loop incident when `attempt >= 2`.

## Systems touched

sprite-pipeline, azure-setup, ci-recovery

## What was done

### Foundry removal (recovering PR #1886 intent)

**Review finding #1 — factory.ts dead code:**
- Removed `createFoundryImageProvider`, `createFoundryChatProvider`,
  `createFoundryVisionProvider`, and `foundryConnection` from
  `scripts/sprites/provider/factory.ts`.
- Removed all `foundry` branches from `createImageProvider`, `createTextProvider`,
  `createVisionProvider`, `createSynthProvider`, `createBriefSelectorProvider`.
- Updated `SUPPORTED_BACKENDS` to `['azure-openai', 'local-a1111']`.
- Error messages now name the actual unsupported backend.

**Review finding #2 — setup-azure-env.ps1 incomplete removal:**
- Removed `-IncludeFoundry`, `-FoundryResourceGroup`, `-FoundryLocation`,
  `-FoundryAccountName`, `-FoundryApiVersion` parameters from `setup-azure-env.ps1`.
- Removed foundry dot-source of `azure-foundry-plan.ps1`.
- Removed foundry endpoint/key fetching and secret sync blocks.
- Removed `$foundryBlock` from the `.env.local` template.

**Review finding #3 — already satisfied:**
- `asset-request.yml` and the workflow test already standardize on `azure-openai`
  on `main` before this session.

**Review finding #4 — imageProviderIsAzureOpenAi / bootstrap tests:**
- Fixed `imageProviderIsAzureOpenAi` in `scripts/sprites/sidecar/env-bootstrap.ts`
  to return `true` for any backend that is NOT `local-a1111` (was: `!== 'foundry'`).
- Updated `tests/unit/sprites/sidecar-env-bootstrap.test.ts` to replace foundry
  test cases with `local-a1111`.

**setup-azure-resources.ps1 / tests:**
- Removed `-IncludeFoundry`, `-FoundryResourceGroup`, `-FoundryLocation`,
  `-FoundryAccountName` params.
- Removed `aif-crawler-nalfeo` and `rg-crawler-foundry` from `PersistentResourceNames`.
- Removed `Ensure-AIFoundryAccount` function.
- Removed dot-source of `azure-foundry-plan.ps1`.
- Removed `if ($IncludeFoundry)` provisioning block.
- Rewrote `setup-azure-resources.tests.ps1` removing all foundry assertions.

**factory.test.ts:**
- Removed `foundry backend (ADR 0033)` and `foundry starter catalog` describe blocks.
- Added `unknown backend rejection (ADR 0072 — foundry retired)` describe block
  verifying that `foundry` now throws an unknown-backend error for all 5 provider
  types.

**azure-foundry-plan.ps1:**
- Added ARCHIVED header; no longer dot-sourced by any active setup script.

**ADR documentation:**
- Marked ADR 0033 as Superseded by ADR 0072.
- Created `docs/knowledge/adr/0072-retire-foundry-standardize-azure-openai.md`.
- Updated `docs/knowledge/adr/README.md`.

### CI recovery loop fix

**Bug:** In `reconcile.mjs`, the `conflict-or-train-short-circuit` path calls
`process.exit(0)` to release the stale automation lock when a PR is in a merge
conflict or train short-circuit state. This path did NOT file a loop incident even
when `attempt >= 2`, which means repeated failures could silently release the lock
without creating a deduplicated incident for investigation.

**Fix:** Added `stallAttempt = state.progressKey ? (state.attempt ?? 0) : 0` check.
When `stallAttempt >= 2`, a loop incident is filed (using `state.fingerprint` and
`state.blockers`) BEFORE `process.exit(0)`. In dry-run mode, the would-file action
is logged instead. The incident fingerprint is stable across rebases (keyed on
`prNumber + blockerFingerprint`, not `headSha`).

**Test:** Added a new test in `reconcile.test.mjs` verifying this behavior:
`exhausted stale automation lock on conflicted PR files loop incident before conflict-reclaim release`.

## Files changed

- `scripts/sprites/provider/factory.ts`
- `scripts/sprites/sidecar/env-bootstrap.ts`
- `scripts/setup-azure-env.ps1`
- `scripts/setup-azure-resources.ps1`
- `scripts/setup-azure-resources.tests.ps1`
- `scripts/azure-foundry-plan.ps1`
- `tests/unit/sprites/factory.test.ts`
- `tests/unit/sprites/sidecar-env-bootstrap.test.ts`
- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/adr/0033-azure-foundry-content-generation.md`
- `docs/knowledge/adr/0072-retire-foundry-standardize-azure-openai.md`
- `docs/knowledge/adr/README.md`

## Closes

- Issue #1908 (CI recovery loop: PR #1886)
- Supersedes PR #1886
