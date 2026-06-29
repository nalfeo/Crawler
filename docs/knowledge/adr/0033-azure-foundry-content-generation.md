# ADR 0033: Migrate Content Generation from Direct Azure OpenAI to Azure AI Foundry

## Status

Proposed

## Date

2026-06-29

## Estimated Complexity

🍎 x 3 — design-only ADR; touches the four sprite providers + factory + env/setup
scripts but ships no runtime code. Implementation is phased and tracked as
follow-ups.

## Context

Every model call in Crawler's content-generation pipeline today goes straight to a
**direct Azure OpenAI deployment**. The provider seam under
`scripts/sprites/provider/` is clean — `ImageProvider`, `TextProvider`,
`SynthProvider`, `BriefSelectorProvider`, `VisionProvider` are all behind interfaces
— but every concrete implementation (`azure-openai.ts`, `azure-chat.ts`,
`azure-chat-synth.ts`, `azure-chat-brief-selector.ts`, `azure-vision.ts`) hardcodes
the Azure OpenAI shape:

- URL: `{AZURE_OPENAI_ENDPOINT}/openai/deployments/{deployment}/{images/edits|chat/completions}?api-version=…`
- Auth: `api-key` header keyed off `AZURE_OPENAI_API_KEY`
- One model family: a `gpt-image-1` image deployment + a `gpt-4o`-class chat/vision deployment

This caps content generation at "whatever we provisioned in one Azure OpenAI
resource." We want **broad model access** for content generation: alternate image
backends (FLUX, Stable Diffusion / SDXL, DALL·E variants), cheaper or stronger chat
models (Llama, Mistral, Phi, DeepSeek, gpt-4o-mini), and a **model router** that
picks per-stage without re-plumbing. ADR‑0003 already anticipated this — it names
"Azure AI Foundry evaluations" as the eventual home for the judge, and the
factory/types carry TODOs for an alternate ("MAI") image path that never landed.

Azure AI Foundry exposes a **single, OpenAI‑compatible unified inference endpoint**
across a multi‑vendor model catalog. Because all five providers already speak the
OpenAI REST envelope (chat-completions JSON, `images/edits` multipart, `image_url`
parts), the migration is mostly **endpoint + auth + model‑name + config**, not a
rewrite of prompt/parse logic. This ADR locks in that transition design.

## Decision

### 1. Foundry becomes a provider behind the existing seam; no contract changes

`ImageProvider` / `TextProvider` / `SynthProvider` / `BriefSelectorProvider` /
`VisionProvider` interfaces stay byte-for-byte. We add Foundry implementations
(`azure-foundry-*.ts`) — or, cheaper, parameterize the existing classes by `mode:
'azure-openai' | 'foundry'` since the request/parse bodies are identical and only the
URL/headers differ. The orchestrator, slicer, sensors, judge schema, and cost
tracker are untouched. The seam is the migration boundary.

### 2. `factory.ts` selects backend; `azure-openai` stays the safe default

Today `SPRITES_PROVIDER`/`SPRITES_TEXT_PROVIDER`/`SPRITES_VISION_PROVIDER`/
`SPRITES_SYNTH_PROVIDER` accept only `azure-openai`. We extend the switch with
`foundry`, defaulting to `azure-openai` so nothing breaks until a `.env.local` opts
in. The factory remains the only place that reads env and builds providers.

### 3. Per-stage model selection replaces per-resource deployment

Foundry addresses models by **name** through one endpoint, so we move from
"one deployment per stage on one resource" to "one endpoint, model per stage":

| Stage              | Today                                       | Foundry                                                                                    |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Image              | `AZURE_OPENAI_IMAGE_DEPLOYMENT=gpt-image-1` | `FOUNDRY_IMAGE_MODEL` (`gpt-image-1`, `flux-1.1-pro`, `sdxl`, …)                           |
| Synth / variations | `AZURE_OPENAI_CHAT_DEPLOYMENT`              | `FOUNDRY_TEXT_MODEL` (`gpt-4o`, `llama-3.3-70b`, `mistral-large`, `deepseek-r1`, `router`) |
| Brief selector     | `AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT`    | `FOUNDRY_BRIEF_SELECTOR_MODEL`                                                             |
| Judge (VLM)        | `AZURE_OPENAI_VISION_DEPLOYMENT`            | `FOUNDRY_VISION_MODEL` (must be vision-capable)                                            |

A `router` value lets Foundry's **model router** pick at runtime. `synthProvider`'s
`providerLabel` becomes `foundry:<model>` so provenance stays reproducible.

### 4. Endpoint + auth: OpenAI-compatible URL, key now, Entra later

Foundry path is `{FOUNDRY_ENDPOINT}/openai/deployments/{model}/{route}?api-version=…`
(unchanged route + parse). Phase 1 keeps `api-key` for the smallest diff;
auth is wrapped so Phase 2 swaps to `Authorization: Bearer` from Entra/Managed
Identity (`@azure/identity`) — closing the root‑credential gap infra/README flags.

### 5. CI default stays mock; live calls opt-in only

`SPRITES_*_PROVIDER=foundry` is opt-in. CI keeps the synthetic mock provider —
deterministic gates only (ADR‑0003); the model router never lands in a gate.

## Consequences

### Positive

- Broad model access (image, text, multimodal, router) with no orchestrator change.
- Mock tests + judge schema unchanged; new providers test like the old ones.
- Path to Entra/MI auth, retiring the root key.

### Negative / Risks

- Catalog drift: model availability/`api-version` varies by region/model → retain `azure-openai` fallback.
- gpt-image-1 vs FLUX/SDXL prompt-steer differently; new image models need a sensor/judge re-baseline before default.
- Two backends until Foundry proven (mitigated by `mode` param, not a fork).

## Alternatives Considered

- Status quo (one resource): rejected — caps catalog, blocks router.
- Public OpenAI / per-vendor SDKs: rejected — compliance + N integrations.
- Big-bang swap: rejected — keep `azure-openai` default, prove via mode flag.

## Migration Phases

1. Factory `foundry` mode + `FOUNDRY_*` env + mocked tests + this ADR (Proposed→Accepted).
2. Live image+text on Foundry default; re-baseline sensors/judge.
3. Entra/MI auth; deprecate `AZURE_OPENAI_*`. 4. Wire model router; record label.
