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

## Systems touched

azure-infra

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

---

## Phase 1 — non-breaking factory wiring (same day)

Estimated: 🍎 x 2 · Actual: 🍎 x 2 · 🎯 Exact · Hello kitties: 2/5 = 0.40 🎀

Implemented the ADR's Phase 1 without behaviour change for existing users:

- `scripts/sprites/provider/factory.ts`: added `SUPPORTED_BACKENDS`,
  `resolveBackend()`, `foundryConnection()`, and a `foundry` branch in all five
  factory functions; `azure-openai` remains the default. New
  `createFoundry{Image,Chat,Vision}Provider` reuse the Azure OpenAI classes
  (identical OpenAI-compatible REST surface). Synth/selector use foundry models
  via `required(... FOUNDRY_TEXT_MODEL)` and selector must differ from text.
- `scripts/sprites/provider/azure-chat-synth.ts`: added `providerLabelPrefix`
  (default `azure-openai`); foundry path labels candidates `foundry:<model>`.
- `scripts/azure-env.example`: `FOUNDRY_*` block + `SPRITES_*_PROVIDER=foundry`.
- `tests/unit/sprites/factory.test.ts`: +7 foundry tests (16 pass total).

Verification: `npm run verify` full suite green (build + headless incl.).
Pushed to PR #474; title/desc re-synthesised to lead with the feat.

Carry-forward: Phases 2–4 (Foundry resource provisioning, Entra auth, judge
cutover) remain. azure-openai path untouched; foundry fully opt-in.
