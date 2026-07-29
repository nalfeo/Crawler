# Handoff - Template-driven sprite post-processing pipeline

## Systems touched

sprite-pipeline

## Summary

- Replaced hardcoded sprite-type branching in sprite post-processing with a YAML template-driven pipeline system.
- Added composable module handlers and template inheritance so sprite types can configure pipeline behavior without code changes.
- Implemented tile-specific template behavior so tiles remain edge-to-edge (no background removal, no transparent trim, no resize/rekey stages).
- Preserved legacy `PostprocessOptions` behavior by mapping runtime overrides into module parameters, including `speckleMode`.
- Addressed review-loop regressions:
  - child-template partial module overrides now resolve correctly against parent configs,
  - `preserve-orphans` and `disabled` speckle mode semantics are preserved,
  - transparent-trim margin rounding and tolerance normalization parity restored.

## Files touched

- `scripts/sprites/postprocess.ts`
- `scripts/sprites/postprocess-modules.ts`
- `scripts/sprites/template-pipeline.ts`
- `scripts/sprites/templates/base.yml`
- `scripts/sprites/templates/character.yml`
- `scripts/sprites/templates/enemy.yml`
- `scripts/sprites/templates/item.yml`
- `scripts/sprites/templates/tile.yml`
- `scripts/sprites/templates/vfx.yml`
- `scripts/sprites/templates/weapon.yml`
- `docs/knowledge/review-ledgers/2026-06-30-template-driven-postprocess-pipeline.review-ledger.json`

## Verification run

- `npm run verify:fast`
- `npm run test:integration -- tests/integration/sprites/rerun.test.ts`
- `npm run verify`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-06-30-template-driven-postprocess-pipeline.review-ledger.json`

## Unresolved issues

- None identified.

## Recommended next steps

- Add focused unit/integration coverage for template loading and inheritance edge-cases (missing type in non-base templates, invalid module ordering).
- Add explicit regression tests for `PostprocessOptions.modules.speckleMode` modes (`edge-drop`, `preserve-orphans`, `disabled`).

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 47,
  "guards": {
    "boom": {
      "crash": 6
    },
    "ctx": {
      "allow": 3
    },
    "ctx-a": {
      "allow": 3
    },
    "ctx-b": {
      "allow": 3
    },
    "edit-bad": {
      "bypass": 3
    },
    "edit-guard-self-protection": {
      "ask": 6
    },
    "pr-a": {
      "deny": 3
    },
    "pr-b": {
      "deny": 3
    },
    "pr-hard": {
      "deny": 3
    },
    "pr-preflight": {
      "deny": 1
    },
    "pr-review-ledger": {
      "deny": 1
    },
    "pr-warn": {
      "allow": 3
    },
    "shell-a": {
      "deny": 3
    },
    "shell-bad": {
      "deny": 6
    }
  },
  "tools": {
    "create_pull_request": 14,
    "edit": 18,
    "powershell": 15
  }
}
```
