---
name: weapon-sweep-100
description: >-
  Kick off the "100 × 3-weapon" Floor 1 balance sweep — 100 seeds against each
  of the three Floor 1 starting weapons (sword, bow, baseball-bat) for 300
  headless runs — and report the per-weapon win rate + score comparison. Use
  when asked to "run the 100 3x weapon sweep", "run a big weapon sweep", "kick
  off the 300-run weapon sweep", "check weapon balance across 100 seeds", or
  "do a large-N Floor 1 weapon balance pass". Wraps `npm run ai:weapon-sweep`
  (`scripts/agent/perf/weapon-sweep.ts`) with the canonical large-sample flags
  and the canonical GitHub workflow-dispatch execution path.
---

# 100 × 3 Weapon Sweep

Run the Floor 1 weapon-balance sweep at large-N (100 seeds × 3 weapons = 300
headless runs) and produce a comparative win-rate / score table. This is the
"real" balance signal — the default `npm run ai:weapon-sweep` runs only 3 seeds,
which is fine for smoke tests but far too noisy to attribute wins/losses to
weapon vs. AI vs. map layout.

> The actual work is done by `scripts/agent/perf/weapon-sweep.ts` (invoked via
> `npm run ai:weapon-sweep`). This skill is the canonical way to launch it at
> the 100×3 sample size and interpret the output. It is a **read-only**
> analysis; it never edits balance numbers, AI, or map data.

## When to run

- **Weapon-balance question at scale** — someone asks whether a Floor 1 weapon
  is over/under-tuned, or whether a recent AI/map/loot change shifted the
  balance between weapons.
- **Confound check before blaming AI / map** — before attributing a Floor 1
  win-rate change to AI behavior or map layout, confirm weapon choice isn't the
  actual driver.
- **Post-merge regression sweep** — after a change that plausibly affects any
  Floor 1 starting weapon (damage, cooldown, projectile, melee AI, room
  layout).

Do **not** use this skill for a single-weapon smoke test — plain
`npm run ai:weapon-sweep` (3 default seeds) is faster and sufficient there.

## How to run (default: GitHub workflow)

```bash
gh workflow run weapon-sweep.yml --ref <branch> \
  -f seed_count=100 \
  -f weapons=sword,bow,baseball-bat \
  -f max_frames=19800
```

Notes:

- This follows the repo standard: broad sweeps (>10 runs) should use GitHub
  infrastructure by default.
- Keep `weapons` at all three Floor 1 starters; changing it defeats the point
  of the comparison.
- `max_frames` defaults to `19_800` (~330s at 60fps), matching the hill-climb
  baseline.
- Download the per-weapon artifact JSONs from the workflow run (artifacts named
  `weapon-sweep-sword`, `weapon-sweep-bow`, `weapon-sweep-baseball-bat`) and use
  those files for reporting.

### Local fallback (only when explicitly requested)

Only use a local run when a human explicitly asks for local execution, or when
running a small smoke sweep (≤10 runs). For a full 100×3 local fallback:

```bash
npm run ai:weapon-sweep -- \
  --seeds 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100 \
  --weapons sword,bow,baseball-bat \
  --out files/weapon-sweep-100.json
```

## Reading the report

The script prints two tables to stdout and writes the full record set to the
`--out` JSON:

1. **Weapon comparison table** — per-weapon `W/L`, `WinRate`, `AvgTime`,
   `AvgLv`, `AvgKills`, `AvgScore` across the 100 seeds.
2. **Extra metrics** — per-weapon `AvgMinHP`, `AvgCloseCall`, `AvgQuests` (how
   often the AI took near-death damage, how many quests completed).

The `--out` JSON contains `summaries` (per weapon) and `allRecords` (every
individual run), which is what you should attach or quote in the handoff /
PR / analysis write-up.

### What to look for

- **Win-rate spread across weapons.** Per the repo constitution, Floor 1
  should hit a **90%+ aggregate win rate over many seeds**. A weapon materially below the
  others is a real balance signal at this sample size (n=100 per weapon is
  ample). A weapon materially _above_ 90% while others sit low is likely a
  broader AI/map problem, not that weapon being "overtuned".
- **Score / kills / level converging or diverging.** If win rates match but
  score/kills differ sharply, the weapon's clear-speed differs — a pacing
  concern, not a "can you win" concern.
- **`AvgMinHP` and `AvgCloseCall`.** Weapons that win at similar rates but
  drive the AI to much lower `MinHP` are riskier; useful when comparing melee
  vs. ranged.

## Guardrails

- **Read-only analysis.** This skill produces numbers; it never edits balance
  data, AI, or map layout. Any follow-up tuning is a separate, deliberate
  change with its own review-harness / apple accounting.
- **Never cherry-pick seeds to make a weapon look good.** Per the AGENTS.md
  rules, the whole point of running 100 seeds is to gate on win-**rate**, not
  on hand-picked comfortable seeds. If a weapon's win rate is bad on this
  sweep, that is the finding — do not rerun with a curated seed list to
  "recover" it.
- **Don't confuse a smoke-test sweep with this one.** A green
  `npm run ai:weapon-sweep` (3-seed default) is not sufficient evidence for a
  balance claim. Anyone citing weapon balance in a PR / handoff / ADR should
  either run this 100×3 sweep or explicitly note the smaller sample.
- **Deterministic only.** Do not swap in LLM-based judging of the resulting
  runs — the sweep output is the numbers; any qualitative claims should still
  be traceable back to the JSON in `--out`.
