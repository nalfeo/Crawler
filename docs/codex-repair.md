# Codex Repair Workflow

This repository includes an autonomous PR-repair router/runner pair:

- `.github/workflows/codex-repair.yml` (event router)
- `.github/workflows/codex-repair-runner.yml` (trusted execution worker)

It executes a CLI-based coding agent (Codex by default) and can be extended to other providers later.

## Setup

1. Ensure the workflow file and scripts are present.
2. Add secrets/variables:
   - Optional secret: `OPENAI_API_KEY` (for the `codex` provider)
   - Optional secret: `GEMINI_API_KEY` (for the `gemini` provider; free AI Studio key works)
   - Optional secret: `AZURE_OPENAI_API_KEY` (for the `azure` provider; billed to your Azure subscription)
   - Optional repo variables:
     - `CODEX_MODEL` (default: CLI's own default; set a valid model to override — for `azure` this is the **deployment** name, e.g. `gpt-4o`)
     - `CODEX_PROVIDER` (default: `codex`; set to `gemini` or `azure`)
     - `CODEX_BIN` (default: provider's own bin — `codex` or `gemini`; `azure` reuses `codex`)
     - `AZURE_OPENAI_ENDPOINT` (for the `azure` provider, e.g. `https://<resource>.openai.azure.com`)
     - `AZURE_OPENAI_API_VERSION` (for the `azure` provider; default `2025-04-01-preview`)
     - `CODEX_ROUTER_ENABLED` (auto-trigger kill switch; the event router only runs when set to `'true'`. Leave unset/`false` for manual-testing-only — the runner's `workflow_dispatch` path is unaffected)
     - `CODEX_VALIDATION_COMMANDS` (newline-separated validation commands override)
3. (Optional) Add `.github/codex-repair.json` for future per-repo settings.

## Local auth + wrapper run (PR-synced sessions)

If you want to run the same codex repair flow locally against a PR branch, use:

- `scripts/codex-repair-local.sh`

Create a local env file (do not commit it):

```bash
cat > .env.codex.local <<'EOF'
OPENAI_API_KEY=...
GITHUB_TOKEN=...
GITHUB_REPOSITORY=nalfeo/Crawler
CODEX_PROVIDER=codex
CODEX_MODEL=
CODEX_BIN=
# For gemini instead: CODEX_PROVIDER=gemini and GEMINI_API_KEY=... (free AI Studio key)
# For Azure OpenAI instead (billed to your Azure subscription):
#   CODEX_PROVIDER=azure
#   AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
#   CODEX_MODEL=<deployment-name>            # e.g. gpt-4o
#   AZURE_OPENAI_API_KEY=...                 # OR omit and use az login (see below)
#   # Keyless local runs: leave AZURE_OPENAI_API_KEY unset and instead set
#   #   AZURE_OPENAI_RESOURCE=<resource> and AZURE_OPENAI_RESOURCE_GROUP=<rg>
#   #   with an active `az login`; the key is fetched at runtime, never stored.
EOF
```

Then run:

```bash
scripts/codex-repair-local.sh --pr 123 --checkout
```

What this wrapper does:

1. Loads env vars from `.env.codex.local` (or `--env-file`).
2. Optionally checks out the PR branch (`--checkout`).
3. Runs the same core local steps as the workflow:
   - `node .github/scripts/codex/gather-context.mjs`
   - `bash .github/scripts/codex/run-provider.sh`
   - `bash .github/scripts/codex/validate.sh`

### How Codex auth works

- The default provider script (`.github/scripts/codex/providers/codex.sh`) runs `codex exec`.
- For that provider, auth comes from `OPENAI_API_KEY` in the environment **or** a prior `codex login` (ChatGPT) session.
- If you use `CODEX_EXEC_COMMAND`, auth can be handled by your custom command instead.
- GitHub API calls (`gather-context`, reporting, thread actions) use `GITHUB_TOKEN`.

## Supported triggers

- `pull_request`: opened, synchronize, reopened, ready_for_review
- `issue_comment` commands on PRs:
  - `/codex fix`
  - `/codex fix ci`
  - `/codex address comments`
  - `/codex resolve conflicts`
- `pull_request_review` (submitted)
- `pull_request_review_comment` (created)
- `workflow_run` (failed runs of `CI` tied to a PR)
- `workflow_dispatch` (internal trusted reroute from privileged triggers)

## Security model

- Uses a two-stage router/worker pattern: privileged event handlers route to `workflow_dispatch`, and only the dispatched run checks out and executes PR code.
- Auto-routing is **disabled in-repo by default**: the router job only runs when the repo variable `CODEX_ROUTER_ENABLED == 'true'`, so re-enabling the workflow in the GitHub UI is not by itself enough to start auto-repair.
- The runner short-circuits ineligible `workflow_dispatch` runs (fork/draft/codex-authored head/attempt limits) **before** checkout, dependency install, or provider execution, so the PR branch and model credentials are never exposed on an ineligible run.
- Model-provider credentials (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY`) are injected at **step scope** on the provider step only — not job-wide — so install/context steps never see them.
- Uses least-privilege workflow permissions:
  - `contents: write`
  - `pull-requests: write`
  - `issues: write`
  - `checks: read`
  - `actions: read`
- Uses `GITHUB_TOKEN`; no PAT required.
- Privileged triggers (`issue_comment`, `workflow_run`, review events) do not directly execute checked-out PR code.
- Fork PRs are skipped for write operations by default.
- Ignores events from `github-actions[bot]`.

## Infinite-loop prevention

- Skips events from `github-actions[bot]`.
- Skips PR heads whose latest commit starts with `codex:`.
- Uses PR-scoped concurrency.
- Tracks attempts/failure streak in a persistent status comment.
- Auto-repair pauses when thresholds are exceeded.

## Context gathered for Codex

The workflow compiles and passes:

- PR title/body/diff
- changed files
- commit history
- unresolved review threads
- review comments
- issue comments
- failing checks and failed CI jobs summary
- merge conflict status
- instruction docs:
  - `AGENTS.md`
  - `CONTRIBUTING.md` (if present)
  - `.github/copilot-instructions.md`
  - `.github/codex-instructions.md`

## Review thread lifecycle

For unresolved threads, the workflow:

1. Includes each thread in Codex prompt context.
2. Expects per-thread decisions in `codex-result.json`.
3. Posts replies directly in each thread.
4. Resolves threads automatically only when marked resolvable and validation succeeded.
5. Leaves unresolved threads open when work is partial.

## Validation

Validation is auto-detected in this order when no override is provided:

1. npm (`npm run verify:fast`)
2. pnpm (`pnpm run verify:fast`)
3. yarn (`yarn verify:fast`)
4. pytest (`pytest -q`)
5. dotnet (`dotnet test`)

Override with `CODEX_VALIDATION_COMMANDS` variable.

## Commit and push

- Commits only when files changed.
- Commit message is fixed to:
  - `codex: repair PR automation`
- Pushes directly to the PR branch.

## Provider abstraction

Provider dispatch is in:

- `.github/scripts/codex/run-provider.sh`
- Router dispatch helper: `.github/scripts/codex/dispatch-repair.mjs`

Current providers:

- `codex` -> `.github/scripts/codex/providers/codex.sh` (auth: `OPENAI_API_KEY` or `codex login`)
- `gemini` -> `.github/scripts/codex/providers/gemini.sh` (auth: `GEMINI_API_KEY` or a cached `gemini` OAuth login)
- `azure` -> `.github/scripts/codex/providers/azure.sh` (Azure OpenAI via the Codex CLI's custom model provider; auth: `AZURE_OPENAI_API_KEY`, or `AZURE_OPENAI_RESOURCE` + `AZURE_OPENAI_RESOURCE_GROUP` with an active `az login`. Requires `AZURE_OPENAI_ENDPOINT`; `CODEX_MODEL` is the deployment name)

Switch providers by setting `CODEX_PROVIDER` (and the matching secret). Add another provider script for new CLIs.

## Limitations

- Codex CLI invocation flags may vary by CLI version; use `CODEX_EXEC_COMMAND` for exact control.
- Large diffs are truncated in prompt to bound token usage.
- Thread resolution can still fail for thread-author/token capability edge cases.
