# ADR 0083: Restore Foundry Image Provider for OpenAI-Compatible Deployments

## Status

Accepted — supersedes [ADR 0072](0072-retire-foundry-standardize-azure-openai.md).

## Date

2026-08-12

## Estimated Complexity

🍎 x 2 — restores one asset-pipeline provider branch and its bootstrap contract; no gameplay behavior changes.

## Context

ADR 0072 retired the `foundry` backend because the available Azure AI Foundry resource had
no usable deployments or quota, while CI's `FOUNDRY_*` configuration was actually pointing at
the ordinary Azure OpenAI account through a parallel code path. It also documented that
`SPRITES_PROVIDER=foundry` should fail fast until a real Foundry deployment became available.

The 2026-08-12 benchmark-readiness pass found a narrower, verified surface: Azure
OpenAI-compatible Foundry image deployments can use the same `images/edits` contract as
`AzureOpenAIImageProvider` when configured with a Foundry endpoint, API key, API version, and
deployment alias. The text, vision, synthesis, brief-selector, FLUX, MAI router, and model-router
contracts remain unverified.

## Decision

Restore `SPRITES_PROVIDER=foundry` for image generation only, backed by the existing
`AzureOpenAIImageProvider` and the `FOUNDRY_ENDPOINT`, `FOUNDRY_API_KEY`,
`FOUNDRY_API_VERSION`, and `FOUNDRY_IMAGE_MODEL` environment variables.

Keep all non-image Foundry provider surfaces unsupported until their request/response contracts
are verified. `SPRITES_TEXT_PROVIDER=foundry`, `SPRITES_VISION_PROVIDER=foundry`, and
`SPRITES_SYNTH_PROVIDER=foundry` continue to fail fast instead of silently routing through Azure
OpenAI.

The sidecar bootstrap treats Foundry as a separate image-provider credential set: an Azure-backed
gallery/worker still requires Azure Storage for queue/blob state, but it must not demand
`AZURE_OPENAI_ENDPOINT` or `AZURE_OPENAI_API_KEY` when `SPRITES_PROVIDER=foundry` has valid
`FOUNDRY_*` image credentials.

## Consequences

### Positive

- The benchmark can run controlled Foundry image-generation experiments through the normal
  sprite provider seam.
- The default `azure-openai` path remains unchanged.
- Unsupported Foundry text and router surfaces remain explicit failures, preserving ADR 0072's
  protection against the earlier brief-selector/model-router footguns.

### Negative

- Foundry remains an opt-in local image backend; setup scripts do not provision or sync Foundry
  resources.
- FLUX and MAI router candidates still need separate contract verification before they can be
  benchmarked or selected.

### Risks

- A Foundry deployment alias can point at a model that does not implement the Azure OpenAI
  `images/edits` shape. That remains a configuration error surfaced by the provider call.

## Alternatives Considered

- **Keep ADR 0072 fully in force.** Rejected because it would make the verified
  OpenAI-compatible image deployment unusable through the normal provider path.
- **Restore every Foundry provider surface.** Rejected because text, vision, synthesis,
  brief-selection, FLUX, MAI, and router contracts are still unverified.

## Systems Touched

sprite-pipeline, azure-setup
