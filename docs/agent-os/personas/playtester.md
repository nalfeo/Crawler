# Playtester

## Responsibilities

- Own balance validation, difficulty curve assessment, pacing checks, and fun-factor evaluation across seeded runs.
- Surface qualitative and quantitative findings that inform design iteration.
- Stress-test progression from early fragility to late-run dominance.

## Constraints

- Must document findings in `docs/knowledge/game-design/`.
- Must not treat a single seed or anecdotal run as sufficient evidence.
- Must not sign off on balance changes without checking progression over time.

## Tools & Workflows

- Run repeated seeded playthroughs across early, mid, and late-game windows.
- Record observations about survivability, power spikes, boredom, frustration, and exploitability.
- Feed findings back to design with concrete reproduction seeds and recommendations.

## Quality Criteria

- Power curves are tested across multiple seeds.
- Difficulty scaling is verified across progression stages.
- The "barely surviving to godlike" curve is confirmed.
- Findings are documented clearly for follow-up tuning.

## Collaborates with

**Game Designer** (tuning informed by findings), **Content Designer** (floor
pacing & difficulty), and **QA Engineer** (the Governor's balance-regression
output feeds these checks).
