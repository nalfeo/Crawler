# ADR 0072: Retire Foundry Backend — Standardize Asset Pipeline on Azure OpenAI

## Status

Accepted (2026-07-24) — supersedes ADR 0033.

## Date

2026-07-24

## Estimated Complexity

🍎 x 2 — tooling-only change; removes dead provider code and setup scripts.

## Context

ADR 0033 (2026-06-29) introduced an Azure AI Foundry (`foundry`) backend for the
asset-generation pipeline to unlock "broad model access" (FLUX, Llama, Mistral, a
model router, cheaper minis) via Azure AI Foundry's unified inference endpoint.

### Why the migration failed

1. **No deployments exist.** The Azure AI Foundry resource `aif-crawler-nalfeo`
   (swedencentral, `AIServices` kind) has **zero deployments** — `az cognitiveservices
   account deployment list` returns `[]`. No quota was obtainable for that resource.

2. **CI used a misnomer.** Because `aif-crawler-nalfeo` had no deployments, the
   `FOUNDRY_*` CI secrets were repointed at the plain Azure OpenAI account
   `aoai-crawler-nalfeo` (westus3, `OpenAI` kind). The "foundry backend" in CI was
   talking to an ordinary Azure OpenAI resource through a second, parallel code path.

3. **Active 400 failures.** The parallel path carried a footgun:
   `createBriefSelectorProvider` enforces
   `FOUNDRY_BRIEF_SELECTOR_MODEL ≠ FOUNDRY_TEXT_MODEL` ("can't grade its own output").
   With `gpt-4o` as the text model and **zero quota** for `gpt-4o-mini` in westus3
   (`OpenAI.GlobalStandard.gpt-4o-mini = 0/0`), the selector was pushed onto the
   reasoning model `gpt-5-mini`, which **rejects `max_tokens` and `temperature`**.
   Result: every CI generation returned 400 and was dropped as "permanent."
   - Error: `Azure chat (brief-selector) returned 400: Unsupported parameter: 'max_tokens'
     is not supported with this model. Use 'max_completion_tokens' instead.`
   - All 8 fresh generations per run were dropped.

4. **The azure-openai backend works end-to-end.** The `azure-openai` backend — which
   the local sidecar has always used — generates with `gpt-4o` for both synth and
   brief-selection. The quarterstaff canary (PR #1307) confirmed this:
   `summary.json` recorded `synth: "azure-openai:gpt-4o"`, 16 real variants + VLM
   judge pass. westus3 quota: `OpenAI.GlobalStandard.gpt-4o = 450/450` (working).

### westus3 quota snapshot (2026-07-24)

| Resource                              | Quota   |
| ------------------------------------- | ------- |
| `OpenAI.GlobalStandard.gpt-4o`        | 450/450 |
| `OpenAI.GlobalStandard.gpt-4o-mini`   | 0/0     |
| `OpenAI.Standard.gpt-4o-mini`         | 0/0     |
| `gpt-5-mini` (reasoning, breaks pipe) | 1/500   |

## Decision

Archive/retire the `foundry` provider backend and standardize the asset pipeline on
the `azure-openai` backend.

### Changes

1. **`asset-request.yml`** — Drain step switches from `FOUNDRY_*` secrets and
   `SPRITES_*_PROVIDER: foundry` to `AZURE_OPENAI_*` secrets with explicit
   `SPRITES_*_PROVIDER: azure-openai` overrides.

2. **`scripts/sprites/provider/factory.ts`** — Remove the `foundry` branches from all
   five provider factories (`createImageProvider`, `createTextProvider`,
   `createVisionProvider`, `createSynthProvider`, `createBriefSelectorProvider`);
   remove `foundryConnection`, `createFoundryImageProvider`, `createFoundryChatProvider`,
   `createFoundryVisionProvider`; remove `foundry` from `SUPPORTED_BACKENDS`.

3. **`scripts/sprites/sidecar/env-bootstrap.ts`** — Update `imageProviderIsAzureOpenAi`
   to check for `local-a1111` instead of `foundry` (the `foundry` special-case is gone).

4. **PowerShell setup scripts** — Remove `FOUNDRY_*` sync from `setup-azure-env.ps1`;
   remove `IncludeFoundry` provisioning from `setup-azure-resources.ps1`; remove
   `aif-crawler-nalfeo` and `rg-crawler-foundry` from persistent resource names.
   Mark `azure-foundry-plan.ps1` as archived (functions kept for reference).

5. **Tests** — Remove foundry backend test suites from `factory.test.ts` and add
   an explicit unknown-backend rejection test; update
   `setup-azure-resources.tests.ps1` to remove the foundry catalog and env-contract
   assertions.

6. **ADR 0033** — Marked Superseded with a reference to this ADR.

### What is kept

- The **provider seam** (interfaces: `ImageProvider`, `TextProvider`, `SynthProvider`,
  `BriefSelectorProvider`, `VisionProvider`) is intact and unchanged. A future
  multi-vendor path can re-land cleanly behind the same interfaces.
- The **`local-a1111` backend** remains available for local Stable Diffusion WebUI.
- The `azure-foundry-plan.ps1` file is kept as an archived reference.
- The `aif-crawler-nalfeo` Azure resource itself is not decommissioned in this ADR;
  it is documented as empty/inactive infra that should not be mistaken for live infra.

## Consequences

### Positive

- CI generations stop 400ing. Every drain run can now generate real art.
- Removes dead code and a parallel code path that was masquerading as working infra.
- Eliminates the `FOUNDRY_BRIEF_SELECTOR_MODEL ≠ FOUNDRY_TEXT_MODEL` footgun.
- `SPRITES_PROVIDER=foundry` in `.env.local` now fails fast with a clear
  "unknown backend" error, guiding users to `azure-openai` or `local-a1111`.
- Developer setup is simpler; no foundry resource group or AIServices account needed.
- `FOUNDRY_*` GitHub secrets can be safely removed once CI confirms the new path works.

### Negative / Risks

- **No broad model access.** The original motivation of ADR 0033 (FLUX, Llama, Mistral,
  model router) is not achievable while `aif-crawler-nalfeo` has zero deployments.
  This risk is accepted: we cannot use what we cannot provision.
- A future Foundry re-land requires re-adding the foundry branches (minimal effort
  given the seam is intact) and provisioning a real Foundry resource with quota.

## Alternatives Considered

- **Band-aid: repoint `FOUNDRY_BRIEF_SELECTOR_MODEL` at a deployable non-reasoning
  model.** Applied as a temporary unblock but not durable — the `foundry` code path
  still has no real Foundry resource behind it, and the parallel path carries ongoing
  maintenance cost.
- **Provision quota on `aif-crawler-nalfeo`.** Not possible currently; no quota
  available in the region for the required models. Revisit if quota becomes available.
- **Keep the `foundry` code path as dead code.** Rejected — dead code carrying
  an active-footgun invariant is worse than removing it. The seam is the extension
  point, not the factory branches.

## Non-Goals

- Re-attempting Azure AI Foundry provisioning (revisit if quota/deployments become available).
- Any change to the brief-selector prompt or the synth/judge logic.

## Systems Touched

sprite-pipeline, azure-setup
