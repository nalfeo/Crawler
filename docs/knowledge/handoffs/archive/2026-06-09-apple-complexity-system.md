# Session Handoff: Apple Complexity System

## Date

2026-06-09

## Apples

Estimated: 🍎🍎🍎 (Medium) — new policy doc + template updates + telemetry script, ~8 files  
Actual: 🍎🍎🍎 (Medium)  
Verdict: 🎯 Exact — scope was well-bounded; no hidden dependencies

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Implemented a project-wide complexity estimation system for agents:

- **`docs/agent-os/policies/complexity-policy.md`** (new) — canonical rubric defining the 1–4 🍎 apple scale, 5 apples = 1 hello kitty 🎀, calibration scoring table (Exact/Under/Over/Miss), codebase-specific examples, anti-patterns, and `apple-log.json` schema.

- **`docs/knowledge/handoffs/TEMPLATE.md`** — added `## Apples` section with Estimated / Actual / Verdict / Hello-kitties fields. Agents fill this in at handoff.

- **`docs/knowledge/adr/TEMPLATE.md`** — added `## Estimated Complexity` field.

- **`docs/knowledge/metrics/apple-log.json`** (new) — machine-readable calibration log, starts empty. Agents append one entry per session at handoff.

- **`.github/copilot-instructions.md`** — added apple estimation to "Before Starting" (step 4) and "Critical Rules".

- **`.github/instructions/core.instructions.md`** and **`game.instructions.md`** — added complexity estimation reminder at the bottom of Rules section.

- **`scripts/agent/docs/apple-calibration.ts`** (new) — reads `apple-log.json`, computes mean delta, miss rate (warns >20%, errors >40%), per-estimated-level breakdown. Skips cleanly when log is empty or has <5 entries.

- **`.github/workflows/docs-update.yml`** — added `apple-calibration` step (continue-on-error: true) between promote-handoffs and archive-handoffs.

## What's Next

- Agents in future sessions should start declaring apple estimates and appending to `apple-log.json`. Once 5+ entries exist, `apple-calibration.ts` will produce real signal.
- Consider adding a `labs.instructions.md` entry once that file exists.

## Blockers

None.

## Branch State

- Branch: `nalfeo/feat-apple-complexity-system`
- All tests passing: yes (1017/1017)
- PR created: yes

## Test Results

```
Test Files  103 passed (103)
Tests       1017 passed (1017)
```

## Key Decisions Made

- **Estimate at start only** (not estimate + retroactive) → user preference; keeps it simple.
- **Actuals scored at handoff** to compute calibration delta.
- **Miss threshold at ±2 apples** (not ±1) to allow reasonable variance without false positives.
- **Telemetry is passive** — no CI enforcement of apple declarations; just observational reporting via `docs-update.yml`.
