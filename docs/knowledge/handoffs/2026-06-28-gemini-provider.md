# Handoff — Gemini provider for codex-repair

## Summary

Added a `gemini` provider to the codex-repair pipeline alongside `codex`, so the
repair agent can run on the Gemini CLI (Google login or free AI Studio key)
instead of requiring OpenAI API billing.

## Files touched

- `.github/scripts/codex/providers/gemini.sh` — new provider: `gemini --yolo [-m MODEL] -p <prompt>`, auth via `GEMINI_API_KEY` or cached OAuth.
- `.github/scripts/codex/run-provider.sh` — dispatch `gemini` case.
- `.github/workflows/codex-repair-runner.yml` — install Gemini CLI when `CODEX_PROVIDER=gemini`, pass `GEMINI_API_KEY`, default `CODEX_BIN` empty (provider picks bin).
- `scripts/codex-repair-local.sh` — provider-aware auth gate for gemini.
- `docs/codex-repair.md` — provider/secret docs.

## Verification

- `@google/gemini-cli` 0.49.0 installed; confirmed `-p/--prompt`, `--yolo`, `-m` flags + `GEMINI_API_KEY`.
- `bash -n` on all touched scripts passes.
- codex provider already validated in CI (install/flags/auth green); gemini provider mirrors that path.

## Unresolved / next steps

- Add `GEMINI_API_KEY` (free AI Studio) repo secret + set `CODEX_PROVIDER=gemini` var to run gemini in CI.
- Live CI run of gemini provider pending the key.

## Apple complexity

Estimate 🍎🍎; actual 🍎🍎. Verdict: matched — provider script + wiring.
