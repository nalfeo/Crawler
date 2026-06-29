# Handoff — 2026-06-29 azure-foundry-content-gen

## Date

2026-06-29

## Persona(s) adopted

**Producer** — design-only, cross-cutting transition spanning all four sprite
content-gen providers + factory + env/setup scripts. No specialist hand-off; the
deliverable is an ADR (no runtime code).

## Apples

Estimated: 🍎 x 3 <!-- declared before work: design ADR spanning multiple systems -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — pure design doc; ADR + index update + handoff, no code.
Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Authored **ADR 0033 — Migrate Content Generation from Direct Azure OpenAI to
Azure AI Foundry** (`docs/knowledge/adr/0033-azure-foundry-content-generation.md`,
status **Proposed**). It designs the transition from one-resource Azure OpenAI
deployments to Foundry's OpenAI-compatible **unified inference endpoint** for broad
model access (image: gpt-image-1/FLUX/SDXL; text/synth/judge: gpt-4o/Llama/Mistral/
DeepSeek + model router).

Key design points:

1. Reuse the existing provider seam unchanged — `ImageProvider`/`TextProvider`/
   `SynthProvider`/`BriefSelectorProvider`/`VisionProvider`. Add a `foundry` mode
   to the same classes (bodies identical; only URL/headers/model differ).
2. `factory.ts` gains `foundry` alongside `azure-openai`, which stays the default.
3. Per-stage model selection (`FOUNDRY_IMAGE_MODEL`/`_TEXT_MODEL`/`_BRIEF_SELECTOR_MODEL`/
   `_VISION_MODEL`, plus `router`) replaces per-resource deployments.
4. Phase-1 `api-key`, Phase-3 swap to Entra/Managed Identity. CI keeps the mock.
5. Updated `docs/knowledge/adr/README.md` (thematic + by-number + next-number).

## Verification

- `npx tsx scripts/agent/docs/check-paths.ts` → 0 findings.
- `npx tsx scripts/agent/docs/check-adr-consistency.ts` → 0 findings.
- `prettier --check` on the ADR + index → clean. Docs-only; no tsc/test impact.

## Carry-forwards

- Implementation is follow-up work (4 phases in ADR). `node_modules` not installed
  in this worktree (`tsx` resolved via npx); run `npm ci` before code phases.
- ADR README count line is stale (says 45/0001–0028); not reconciled here.
