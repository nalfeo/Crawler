# Handoff — Codex CLI bootstrap

## Summary

Bootstrapped the Codex CLI for the existing codex-repair pipeline and fixed the
breakage it exposed. Installed `@openai/codex` 0.142.4, authed locally via
ChatGPT login, and confirmed a live `codex exec` smoke test (`CODEX_OK`).
`gather-context.mjs` runs locally against a real PR. The repo `OPENAI_API_KEY`
secret is set for CI. The CI runner was failing on `--non-interactive` /
`gpt-5.5`; both are removed.

## Files touched

- `.github/scripts/codex/providers/codex.sh` — drop removed `--non-interactive`;
  run `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox`,
  prompt via stdin, only pass `--model` when `CODEX_MODEL` set.
- `.github/workflows/codex-repair-runner.yml` — remove invalid `gpt-5.5` default.
- `scripts/codex-repair-local.sh` — drop `gpt-5.5` default; accept existing
  `codex login` session instead of forcing `OPENAI_API_KEY`.
- `docs/codex-repair.md` — auth + model notes.
- `.gitignore` — ignore `.github/scripts/codex/runtime/` and `.env.codex.local`.

## Verification

- `codex --version` → 0.142.4; `codex login status` → logged in (ChatGPT).
- `codex exec` smoke test returned `CODEX_OK`.
- `node .github/scripts/codex/gather-context.mjs` produced prompt.md + context.json for PR #455.
- CI: provider step previously failed with `unexpected argument '--non-interactive'`; root cause fixed here.

## Unresolved / next steps

- The pasted `OPENAI_API_KEY` was shared in plaintext — rotate and re-set via `gh secret set OPENAI_API_KEY`.
- After merge, re-dispatch the codex-repair runner to confirm the provider step is green.

## Apple complexity

Estimate 🍎🍎; actual 🍎🍎. Verdict: matched — install, auth, small script/doc fixes.
