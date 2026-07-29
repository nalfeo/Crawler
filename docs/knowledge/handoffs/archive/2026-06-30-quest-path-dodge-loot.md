# Session Handoff: Quest path dodge + panic beeline

## Date

2026-06-30

## Persona

- **Producer** (AI gameplay behavior + tests + review-harness orchestration)

## Systems touched

inventory, quests

## Apple Estimate

- Estimated: **2 apples**
- Actual: **2 apples**
- Verdict: **accurate**

## Summary

- Added collapse-time pressure modeling for BT AI with a deterministic panic profile from floor deadline remaining time.
- Implemented low-time panic behavior so AI hard-beelines objective flow under 60s while stairs are undiscovered.
- Increased risk tolerance as collapse nears by dynamically reducing opportunistic collect/farm pull influence and scaling dodge influence to a non-zero panic floor.
- Disabled quest-giver detours during hard beeline mode to preserve objective-first routing.
- Fixed a blocking edge case from plan review: in panic beeline windows, Track A COLLECT is now suppressed so the AI cannot fall back to loot collection when progress objective is temporarily null.

## Files Touched

- `src/game/ai/bt-ai-provider.ts`
- `src/game/ai/bt-ai-tuning.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/unit/ai-collapse-panic-profile.test.ts`
- `docs/knowledge/review-ledgers/2026-06-30-quest-path-dodge-loot.review-ledger.json`

## Review Harness

- Initialized ledger for 2-apple tier:
  - `docs/knowledge/review-ledgers/2026-06-30-quest-path-dodge-loot.review-ledger.json`
- Plan review (`gpt-5.4`) surfaced 3 concerns; resolved 3.
- Code review loop (`claude-sonnet-4.6`) returned clean final round.
- Ledger validated successfully with `npm run review:ledger -- validate ...`.

## Verification Run

- `npm run verify:fast` (after implementation) - pass
- `npm run verify:fast` (after review-fix pass) - pass
- `npm run verify` - reached PR prereqs; blocker was missing handoff file
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-06-30-quest-path-dodge-loot.review-ledger.json` - pass

## Unresolved Issues

- None in code changes.
- PR-preflight handoff requirement was satisfied by adding this file.

## Recommended Next Steps

1. Run `npm run verify:pr-prereqs` (now that handoff exists) to confirm green prereq gate.
2. Commit and push branch, then open PR.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 15,
  "guards": {
    "boom": {
      "crash": 2
    },
    "ctx": {
      "allow": 1
    },
    "ctx-a": {
      "allow": 1
    },
    "ctx-b": {
      "allow": 1
    },
    "edit-bad": {
      "bypass": 1
    },
    "edit-guard-self-protection": {
      "ask": 2
    },
    "pr-a": {
      "deny": 1
    },
    "pr-b": {
      "deny": 1
    },
    "pr-hard": {
      "deny": 1
    },
    "pr-warn": {
      "allow": 1
    },
    "shell-a": {
      "deny": 1
    },
    "shell-bad": {
      "deny": 2
    }
  },
  "tools": {
    "create_pull_request": 4,
    "edit": 6,
    "powershell": 5
  }
}
```
