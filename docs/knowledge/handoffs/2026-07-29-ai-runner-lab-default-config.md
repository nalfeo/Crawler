# 2026-07-29 AI Runner Lab Default Config Fix

## Systems touched

ai-runner-lab, ai

## Problem

`src/labs/ai-runner-lab/index.ts` initialized its AI config with hardcoded `LEGACY`
fallbacks and a pre-promotion `retreatThreshold: 0.15`:

```ts
pathingMode: persisted?.pathingMode ?? AIPathingMode.LEGACY,
decisionMode: persisted?.decisionMode ?? AIDecisionMode.LEGACY,
// ... and three BehaviorTreeAI constructor calls with:
retreatThreshold: 0.15,
```

Production defaults (`DEFAULT_CONFIG` in `src/game/ai/bt-ai-tuning.ts`) are
`pathingMode: riskRewardFused`, `decisionMode: legacy`, `retreatThreshold: 0.1`,
`farmPullWeight: 0.12` — promoted from the 2026-07-21 AI Sweep winner.

A fresh lab session (cleared persistence) was silently running the pre-promotion
LEGACY movement path, so debugging in the lab could not reproduce headless runner
or game behavior.

## Fix

Imported `DEFAULT_CONFIG` from `bt-ai-tuning.ts` and replaced all duplicated literals:

- `pathingMode ?? AIPathingMode.LEGACY` → `pathingMode ?? DEFAULT_CONFIG.pathingMode`
- `decisionMode ?? AIDecisionMode.LEGACY` → `decisionMode ?? DEFAULT_CONFIG.decisionMode`
- All three `retreatThreshold: 0.15` → `retreatThreshold: DEFAULT_CONFIG.retreatThreshold`
- Added explicit `farmPullWeight: DEFAULT_CONFIG.farmPullWeight` at all three
  `BehaviorTreeAI` constructor sites
- Updated stale comment about "both default LEGACY"

## Test added

`tests/unit/ai-runner-default-config-wiring.test.ts` — source-string + runtime assertions
verifying the lab imports and uses `DEFAULT_CONFIG` for all affected knobs, and that
`DEFAULT_CONFIG` itself holds the promoted production values.

## Observe before done (runtime artifact)

- **Before (pre-fix commit `379ea3f` / detached worktree on `aaf1963~1`)**:
  launched `npm run lab -- --host 127.0.0.1 --port 4174`, opened
  `http://127.0.0.1:4174/lab.html?lab=ai-runner`, cleared `localStorage`, and
  observed:
  - AI Modes combobox defaults: `Pathing = legacy`, `Decision = legacy`
  - Telemetry modes line: `pathing=legacy · decision=legacy`
- **After (current branch head)**: launched
  `npm run lab -- --host 127.0.0.1 --port 4173`, opened
  `http://127.0.0.1:4173/lab.html?lab=ai-runner`, cleared `localStorage`, and
  observed:
  - AI Modes combobox defaults: `Pathing = riskRewardFused`, `Decision = legacy`
  - Telemetry modes line: `pathing=riskRewardFused · decision=legacy`
- Evidence capture method: Playwright accessibility snapshots of the live lab
  panel (deterministic DOM text), not source inspection.

## Files changed

- `src/labs/ai-runner-lab/index.ts` — import + literal replacements + explicit
  `farmPullWeight` wiring
- `tests/unit/ai-runner-default-config-wiring.test.ts` — source-string/runtime
  guards for pathing/decision/retreat/farm defaults
- `docs/knowledge/review-ledgers/2026-07-29-ai-runner-lab-default-config.review-ledger.json` — 1🍎 ledger

## Apple estimate

🍎 (1 apple) — targeted import + literal substitution in one file, one test file.

## Closes

Closes nalfeo/Crawler#2317
