# Handoff: Add --model parameter to sprites:run CLI

**Date:** 2026-07-03  
**Branch:** nalfeo-sprite-cli-model-param  
**Apple estimate:** 🍎 (1)

## Summary

Added a `--model <name>` flag to `scripts/sprites/cli.ts` so users (and
future UX/automation) can select the image generation model at invocation
time, without having to manage `AZURE_OPENAI_IMAGE_DEPLOYMENT` in the
environment.

Accepted models: `gpt-image-1` (factory baseline/default), `gpt-image-2`,
`mai-image-2.5-flash`, `gpt-image-1-mini`, `mai-image-2.5`. Precedence:
`--model` > `AZURE_OPENAI_IMAGE_DEPLOYMENT` > factory default. The baseline
`gpt-image-1` is included so the default / only-tested deployment stays
selectable and benchmarkable via `--model` (review feedback on PR #725) — the
allowlist now references `DEFAULT_AZURE_DEPLOYMENT` from
`provider/factory.ts` directly so it can never drift out again. Custom
deployment names are still reachable through the `AZURE_OPENAI_IMAGE_DEPLOYMENT`
env var; the validating allowlist is intentionally kept for `--model`.

## Files touched

- `scripts/sprites/cli.ts` — added `SUPPORTED_IMAGE_MODELS` (now sourcing the
  baseline from `DEFAULT_AZURE_DEPLOYMENT`), `--model` arg parsing, env override
  in `main()`, and `--help` documentation. Exported `parseArgs` +
  `SUPPORTED_IMAGE_MODELS` for unit testing.
- `scripts/sprites/provider/factory.ts` — exported `DEFAULT_AZURE_DEPLOYMENT`
  (the `gpt-image-1` baseline) so the CLI allowlist binds to the canonical
  default.
- `tests/unit/sprites/cli-model-arg.test.ts` — new unit test guarding the
  allowlist (baseline present + selectable, unsupported models still rejected).
- `docs/knowledge/review-ledgers/2026-07-03-sprite-cli-model-param.review-ledger.json` — 1-apple ledger.
- `docs/knowledge/handoffs/2026-07-03-sprite-cli-model-param.md` — this file.

## Verification

- `npm run verify:fast` — green (typecheck + lint + changed unit tests).
- `npm run verify` — green (typecheck, lint, format, guards, unit +
  integration, PR prereqs, build).
- **Observe-before-done (rule #10):** the new unit test is the deterministic
  artifact. It FAILS on the pre-fix allowlist
  (`--model 'gpt-image-1' is not supported`) and PASSES after adding the
  baseline; verified by temporarily removing the baseline and re-running
  (`2 failed → 6 passed`). This is a dev-tooling CLI, so a unit test is the
  correct real artifact — no game/headless run needed.
- Review ledger validated: `npm run review:ledger -- validate` → valid
  1-apple ledger.

## Unresolved issues

None. The PR #725 review thread about the omitted baseline model
(PRRT_kwDOSvo2Ms6ORf46) is addressed by this change.

## Recommended next steps

- Wire `--model` selection into the gallery UX (asset-request issue flow).
- Consider adding `--model` to `sprites:batch` / `sprites:worker` CLIs for
  batch benchmark use (the Sprite benchmark prep session requested this
  change for that purpose).
