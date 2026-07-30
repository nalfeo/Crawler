# Handoff: infra README secrets attribution fix

**Date:** 2026-06-24
**Session:** address-review-comments-pr-262
**Branch:** copilot/asset-generation-azure-queue

## What was done

Fixed a documentation ambiguity in `infra/README.md` (PR #262, reviewer comment on `infra/README.md:126`).

The "This sets these repo secrets" sentence and the full secrets list appeared immediately after the `pwsh scripts/setup-azure-resources.ps1` code block, making it look as if that script set the GitHub secrets. In reality, only the `-SyncGitHubSecrets` variant of `setup-azure-env.ps1` writes secrets.

**Fix:** Moved the secrets list and `-GitHubRepo` note to be under the `-SyncGitHubSecrets` command block. The `setup-azure-resources.ps1` section now accurately says "no `.env.local` writes or secrets sync".

## CI status

All CI checks passing on commit 97a0072 (head before this session).

## Apple metrics

Estimated: 🍎 (1) | Actual: 🍎 (1) | Verdict: exact
