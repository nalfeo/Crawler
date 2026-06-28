# Codex Repair Workflow

This repository includes an autonomous PR-repair router/runner pair:

- `.github/workflows/codex-repair.yml` (event router)
- `.github/workflows/codex-repair-runner.yml` (trusted execution worker)

It executes a CLI-based coding agent (Codex by default) and can be extended to other providers later.

## Setup

1. Ensure the workflow file and scripts are present.
2. Add secrets/variables:
   - Optional secret: `OPENAI_API_KEY` (for Codex auth if required by your CLI setup)
   - Optional repo variables:
     - `CODEX_MODEL` (default: `gpt-5.5`)
     - `CODEX_PROVIDER` (default: `codex`)
     - `CODEX_BIN` (default: `codex`)
     - `CODEX_VALIDATION_COMMANDS` (newline-separated validation commands override)
3. (Optional) Add `.github/codex-repair.json` for future per-repo settings.

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

Current provider:

- `codex` -> `.github/scripts/codex/providers/codex.sh`

You can swap providers later by adding another provider script and changing `CODEX_PROVIDER`.

## Limitations

- Codex CLI invocation flags may vary by CLI version; use `CODEX_EXEC_COMMAND` for exact control.
- Large diffs are truncated in prompt to bound token usage.
- Thread resolution can still fail for thread-author/token capability edge cases.
