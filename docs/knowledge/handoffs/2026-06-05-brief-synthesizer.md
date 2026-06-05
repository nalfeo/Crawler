# 2026-06-05 — Brief synthesizer (`sprites:synth`)

## What shipped

PR: `feat(sprites): brief synthesizer + reference selector`. Branch `nalfeo/brief-synthesizer` off `main` (b873dc1). Six commits, conventional.

- `scripts/sprites/reference-allow-list.ts` — discovers `public/assets/kenney/*/spritesheet.png` at runtime, attaches curated per-pack notes, refuses path-traversal ids. Sole point that converts an LLM-supplied reference id to a real repo path. **Defence in depth:** the synthesizer also re-`statSync`s every chosen reference at write time so a sheet that disappears between catalog-build and validation gets caught.
- `scripts/sprites/synthesize-brief.ts` — orchestrator. Single Azure structured-output call per `synthesizeBrief()` invocation (cost discipline). Validates: banned-adjective regex with word boundaries (`cool|awesome|epic|amazing|nice`); reference ids must come from the allow-list AND exist on disk; no duplicate references in a candidate; 2-3 refs and 3-5 seeds per candidate; description 50-300 chars. Type inference requires `typeConfidence >= 0.9` to auto-assign — otherwise the caller must pass `--type`. Refuses to run with `env.CI` truthy.
- `scripts/sprites/provider/azure-chat-synth.ts` — Azure OpenAI chat-completions adapter, sibling to `azure-chat.ts`. Injectable `fetch` for tests, no retries (orchestrator owns retry policy).
- `scripts/sprites/provider/factory.ts` — `createSynthProvider()` hard-fails (throws) when `AZURE_OPENAI_CHAT_DEPLOYMENT` / endpoint / key are missing, unlike `createTextProvider` which returns null. Synth is the entire point of `sprites:synth`, so missing creds = user error, not "skip silently".
- `scripts/sprites/synth-cli.ts` + `npm run sprites:synth` — flag parser (`--type`, `--candidates`, `--out`, `--allow-partial`, `--help`), per-candidate summary table, promotion instructions.
- `briefs/draft/.gitignore` — staging area for human-picked candidates. Three-stage lifecycle: `generated/brief-candidates/` (gitignored, machine output) → `briefs/draft/<type>/` (gitignored, human-picked) → `briefs/<type>/` (committed, sensor-validated).
- Tests: 42 new (`reference-allow-list.test.ts` ×9, `synthesize-brief.test.ts` ×23, `synth-cli.test.ts` ×9, integration `synth-to-generate.test.ts` ×1). Full unit suite green: 74 files, 711 tests.
- Docs: `docs/agent-os/sprite-style.md` got a new "Synthesising briefs" H2; `briefs/README.md` got the three-stage lifecycle.

## Rubber-duck adjustments adopted

- Replaced dynamic `require('node:fs')` with top-level `statSync` import (ESLint rule + ESM).
- Added separate `referenceFileExistsAtSynthesisTime` option distinct from the catalog's `fileExists` hook, so tests can exercise the "deleted between catalog-build and validation" defence without polluting catalog discovery.
- Dropped a confusing `sourceIndex` field from the sidecar; `written[i].id` already encodes ordering.
- Removed an unreachable path-traversal guard in `normaliseName`: the non-alphanumeric → `-` collapse already neutralises `..` / `/` / `\`. Tests now assert *safe normalisation* (e.g. `'../etc/passwd'` → `'etc-passwd'`) rather than rejection.

## Draft-policy decision

Defaulted to the policy hinted in the task: `briefs/draft/` is **gitignored**, only the curated `briefs/<type>/` form lands in history. A draft that never produces a passing sprite never pollutes the repo. If we ever want PR-attached draft review, we can flip this trivially by removing the gitignore — no code changes needed. I see no reason to commit drafts now; the synth is cheap and reproducible (sidecar includes prompt hash + model id).

## Pipeline gap I noticed during the real run

Synth caps `embellishmentSeeds` at 3-5 per candidate, but the variation expander's default `minVariations` for weapons is 4 (per `data/sprite-types/weapon.json`). On a synth that produces 3 seeds (well within `MIN_SEEDS`), the expander then has to manufacture a fourth from thin air. In the integration test you can see the warning `expand-variations: text provider not configured`. If we tighten synth's `MIN_SEEDS` to 4 we de-couple from the expander, but the cleaner fix is probably to make the synth aware of the merged sprite-type defaults so it generates *at least* `minVariations` seeds.

## Real synth example

Subject: **scythe** (`--type weapon`, default 3 candidates). Provider `azure-openai:gpt-4o`. Prompt hash `f14d4a246d58…`.

- `scythe-v1` — "A large, menacing scythe with a curved blade mounted on a gnarled wooden handle. … Oriented vertically, with the blade sweeping leftward." Refs: `roguelike-rpg-pack`, `tiny-dungeon`. Seeds: jagged cracks, bone ornament, faded bloodstains. Rationale: dark, primal aesthetic.
- `scythe-v2` — "A ceremonial scythe with a slim, polished blade and a gleaming steel shaft. … Blade curves rightward." Refs: `roguelike-rpg-pack`, `tiny-battle`. Seeds: golden filigree, jewelled handle base, runes etched into shaft. Rationale: refined, ceremonial.
- `scythe-v3` — "A crude, rusted scythe designed for reaping rather than combat. The blade is chipped and uneven … wooden rod bound with string." Refs: `tiny-dungeon`, `tiny-town`. Seeds: splintered handle, frayed string grip, grime along blade. Rationale: grounded in practicality.

Three visibly distinct silhouettes (left-curve menacing, right-curve ornate, upward-curve rustic), each with concrete pose + colour cues and a sensible reference pick. The user can pick one without re-prompting.

## Windows note for follow-ups

`verify:fast` shell script is still broken on Windows — use `npx tsc --noEmit; npm run lint; npx vitest run --project unit` directly. Azure creds env file lives at `~\.copilot\session-state\f7220956-761b-43c9-86f5-7698a3e3cf46\files\azure-sprite-pipeline.env`; the env defines `AZURE_OPENAI_VISION_DEPLOYMENT=gpt-4o` but the synth provider expects `AZURE_OPENAI_CHAT_DEPLOYMENT`. Either alias one to the other at invocation time (`$env:AZURE_OPENAI_CHAT_DEPLOYMENT = $env:AZURE_OPENAI_VISION_DEPLOYMENT`) or add `AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o` to the env file. **Don't rename** `AZURE_OPENAI_VISION_DEPLOYMENT` — the image edit / vision callers still use it.

## Important content-filter footgun

First attempt at the system prompt used strict directive language (HARD RULES, MUST, NEVER, forbidden, numbered rules with explicit quoted banned-word list). Azure's gpt-4o content classifier flagged it as a jailbreak attempt (`jailbreak: detected: true`) and 400'd every call, regardless of subject. Fix was to rewrite the prompt as an art-director brief in conversational prose — same semantic content, no quoted banned-word list, no all-caps imperatives. Future-you: if you tighten the prompt again with directive shapes, verify the real Azure round-trip before assuming it works.

This is **not just a synth concern** — it applies to every chat-completions prompt in the repo. Existing prompts that survive (variations expander, etc.) either route through the image-edits API (different filter stack) or simply haven't been tested with policy-adjacent subjects yet. To prevent future authors (judge rubric tuner, expander revisions, anything new) from relearning this, I added a "Writing prompts for Azure OpenAI chat" H2 to `docs/agent-os/sprite-style.md` that lists the directive shapes that trip the filter and the conversational shapes that don't, plus the "push enforcement to validator code, not the prompt" pattern.
