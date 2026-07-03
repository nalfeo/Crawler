# Handoff: Add --model parameter to sprites:run CLI

**Date:** 2026-07-03  
**Branch:** nalfeo-sprite-cli-model-param  
**Apple estimate:** 🍎 (1)

## Summary

Added a `--model <name>` flag to `scripts/sprites/cli.ts` so users (and
future UX/automation) can select the image generation model at invocation
time, without having to manage `AZURE_OPENAI_IMAGE_DEPLOYMENT` in the
environment.

Accepted models: `gpt-image-2`, `mai-image-2.5-flash`, `gpt-image-1-mini`,
`mai-image-2.5`. Precedence: `--model` > `AZURE_OPENAI_IMAGE_DEPLOYMENT` >
factory default.

## Files touched

- `scripts/sprites/cli.ts` — added `SUPPORTED_IMAGE_MODELS`, `--model` arg
  parsing, env override in `main()`, and `--help` documentation.
- `docs/knowledge/review-ledgers/2026-07-03-sprite-cli-model-param.review-ledger.json` — 1-apple ledger.
- `docs/knowledge/handoffs/2026-07-03-sprite-cli-model-param.md` — this file.

## Verification

- Typecheck: pre-existing `@types/node` missing errors in worktree (no
  `node_modules/` in the worktree itself); no new errors introduced in
  `cli.ts`.
- `verify:fast` blocked on eslint infrastructure issue (wrong eslint version
  via npx in worktree environment) — pre-existing, unrelated to this change.
- Review ledger validated: `✅ valid 1-apple ledger`.

## Unresolved issues

None — this is a straightforward additive change with no side effects on
existing behaviour.

## Recommended next steps

- Wire `--model` selection into the gallery UX (asset-request issue flow).
- Consider adding `--model` to `sprites:batch` / `sprites:worker` CLIs for
  batch benchmark use (the Sprite benchmark prep session requested this
  change for that purpose).
