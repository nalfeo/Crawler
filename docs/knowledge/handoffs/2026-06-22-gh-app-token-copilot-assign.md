# Handoff: Use GH App Token for Copilot Issue Assignment

## Date

2026-06-22

## What was done

Updated three CI workflows to generate a GitHub App token (via
`actions/create-github-app-token@v1`) and use it when creating issues assigned
to `@copilot`, replacing the previous `github.token` / `GITHUB_TOKEN`.

### Motivation

The default `GITHUB_TOKEN` (a `github-actions[bot]` identity) is silently
ignored by GitHub when assigning issues to `@copilot` — the Copilot coding
agent is not triggered. A token minted by a GitHub App (acting as a user-level
identity) is required for the assignment to register and fire the trigger.

### Files changed

| File                                         | Change                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.github/workflows/coverage-gap-copilot.yml` | Added `actions/create-github-app-token@v1` step; passed token to `actions/github-script` |
| `.github/workflows/copilot-review-ping.yml`  | Same                                                                                     |
| `.github/workflows/nightly-mutation.yml`     | Same for the "Create baseline update issue for copilot" step in the `mutation-score` job |

### Secrets used

- `secrets.APP_ID` — numeric GitHub App ID
- `secrets.APP_PRIVATE_KEY` — PEM private key for the App

Both are already configured as repository secrets.

## Status

Complete. No code changes — CI/workflow YAML only.
