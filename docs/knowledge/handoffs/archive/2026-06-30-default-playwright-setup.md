# Session Handoff: Default Playwright setup for Copilot sessions

**Date**: 2026-06-30  
**Apple estimate**: 2 🍎  
**Session branch**: `nalfeo-default-playwright-setup`

## Summary

Ensured Playwright is provisioned by default in Copilot cloud-agent sessions by updating the repository-level setup steps file used at session bootstrap.

### Key Changes

1. Updated `.github/copilot-setup-steps.yml` to add an explicit Playwright browser install step right after dependency installation.
2. Made the install step OS-aware:
   - Linux runners: `npx playwright install chromium --with-deps`
   - Non-Linux runners: `npx playwright install chromium`
3. Kept existing typecheck and `verify:fast` bootstrap checks unchanged.

## Files Changed

**Modified**:

- `.github/copilot-setup-steps.yml`

**Added**:

- `docs/knowledge/review-ledgers/2026-06-30-default-playwright-setup.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-06-30-default-playwright-setup.json`

## Verification

- `bash scripts/agent/preflight.sh`
- `npm run verify:fast`
- `npm run verify`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-06-30-default-playwright-setup.review-ledger.json`

## Unresolved Issues

None.

## Next Steps

1. Merge this PR so default-branch Copilot setup includes Playwright install.
2. Copilot cloud sessions will then bootstrap with Chromium available deterministically.

## Apples

- Estimated: 2
- Actual: 2
- Delta: 0
- Verdict: exact
- Hello kitties: 0.40

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 30,
  "guards": {
    "boom": {
      "crash": 4
    },
    "ctx": {
      "allow": 2
    },
    "ctx-a": {
      "allow": 2
    },
    "ctx-b": {
      "allow": 2
    },
    "edit-bad": {
      "bypass": 2
    },
    "edit-guard-self-protection": {
      "ask": 4
    },
    "pr-a": {
      "deny": 2
    },
    "pr-b": {
      "deny": 2
    },
    "pr-hard": {
      "deny": 2
    },
    "pr-warn": {
      "allow": 2
    },
    "shell-a": {
      "deny": 2
    },
    "shell-bad": {
      "deny": 4
    }
  },
  "tools": {
    "create_pull_request": 8,
    "edit": 12,
    "powershell": 10
  }
}
```
