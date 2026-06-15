# Handoff: Azure OpenAI local dev bootstrap

**Date:** 2025-06-09  
**Branch:** nalfeo/azure-env-setup  
**Author:** Copilot

## Summary

Added a one-shot PowerShell script to bootstrap Azure OpenAI credentials on any local machine or worktree. Solves the multi-machine friction of manually copying values from the portal.

## Files touched

| File                          | Change                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| `scripts/setup-azure-env.ps1` | New bootstrap script                                          |
| `scripts/azure-env.example`   | New template with var names (empty values)                    |
| `.gitignore`                  | Added explicit `.env.local` comment/entry alongside `*.local` |

## How it works

`scripts/setup-azure-env.ps1`:

- Guards against cloud/CI environments (`$env:CI`, `$env:GITHUB_ACTIONS`, `$env:CODESPACES`) — exits 0 (no-op) in those contexts
- Fetches the API key from Azure via `az cognitiveservices account keys list`
- Writes `.env.local` (git-ignored by `*.local` pattern) with three vars:
  - `AZURE_OPENAI_ENDPOINT`
  - `AZURE_OPENAI_API_KEY`
  - `AZURE_OPENAI_VISION_DEPLOYMENT`
- Accepts `-Force` flag to overwrite/rotate credentials

## Setup on a new machine

```powershell
az login
pwsh scripts/setup-azure-env.ps1
```

Requires Owner or Contributor on the `rg-crawler-sprites` resource group.

## Verification

- Script tested locally; `.env.local` written correctly
- `*.local` pattern in `.gitignore` already prevents tracking — confirmed with `git check-ignore -v .env.local`
- Cloud guard: `$env:GITHUB_ACTIONS = 'true'` test exits with message "Cloud/CI environment detected — skipping"

## Unresolved issues

- Cloud machines (GitHub Actions, Copilot coding agent) will need a separate secret wiring step via GH Secrets or Azure KeyVault. That is intentionally deferred and documented in the script.

## Recommended next steps

- Wire `AZURE_OPENAI_*` vars as repository secrets in GitHub Actions for CI jobs that need them
- Potentially add Codespaces devcontainer secrets integration
