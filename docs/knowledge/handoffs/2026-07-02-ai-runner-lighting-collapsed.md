# Handoff — Collapse AI runner Lighting panel by default

## Date

2026-07-02

## Persona(s) adopted

Game Designer — lab UX tweak on an existing gameplay-debug surface.

## Routing verdict

✅ right persona — single-layer lab UX change, no core/engine/game logic touched.

## Apples

Estimated: 🍎 x 1
Actual: 🍎 x 1
Verdict: 🎯 Exact — one-line lil-gui folder change plus a focused source-guard test.

Hello kitties: 1/5 = 0.20 🎀

## Systems touched

ai-combat-balance, lighting

## What Was Done

- `src/labs/ai-runner-lab/index.ts`: added `lightingFolder.close();` after the
  `Lighting` folder and its `Perf` subfolder are fully built, so the panel renders
  collapsed by default. Matches existing repo convention (`lab-runner.ts` closes
  `globalControlsFolder`, `pathfinding-lab` closes `mobFolder`, `tile-blend-lab`
  closes `previewFolder`).
- `tests/unit/ai-runner-lighting-controls.test.ts`: added an assertion that the
  source contains `lightingFolder.close();`, locking in the collapsed default.

## Observe Before Done

- Before: lil-gui folders render expanded by default, so the `Lighting` folder
  opened on load.
- After: ran the lab at `http://localhost:6381/lab.html?lab=ai-runner` and confirmed
  via DOM that the `Lighting` folder carries the `lil-closed` class and its children
  wrapper has `offsetHeight: 0` (collapsed). Sidebar screenshot shows `▸ Lighting`
  in the collapsed state. `Perf` remains a nested (open) subfolder, hidden while its
  parent is collapsed.

## Validation

- `npm run verify:fast` ✅
- `npm run verify` ✅ (2844 unit + 49 integration + 17 headless pass; typecheck,
  lint, format green). `verify:pr-prereqs` initially flagged the missing handoff +
  ledger (now added).
- `npm run build` ✅ (built in ~3s; pre-existing Phaser chunk-size warning only).
- `bash scripts/agent/lab-gate-check.sh` ✅
- Review harness (1🍎 → `code_review`): single-model `code-review` agent
  (claude-sonnet-4.6) returned **no concerns** on round 1. Ledger:
  `docs/knowledge/review-ledgers/2026-07-02-ai-runner-lighting-collapsed.review-ledger.json`
  (`npm run review:ledger -- validate` ✅).

## Unresolved / Follow-up

- None. Optional future polish: if more folders accumulate, consider a shared
  helper to set default-collapsed state and/or persist per-folder open/close in
  lab session storage.

## Branch State

- Branch: `nalfeo-ai-runner-lighting-collapsed`
- Guard telemetry file present: yes (see section below)

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
