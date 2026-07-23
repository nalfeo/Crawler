# Handoff — 2026-06-21 apple-log-per-session-files

## Apples

- Estimated: 🍎🍎 (Small)
- Actual: 🍎🍎 (Small)
- Delta: 0
- Verdict: 🎯 Exact
- Notes: Exactly as scoped — 3 files + new directory, no new systems.

## Systems touched

docs-tooling

## What Changed

The apple complexity system was still appending to a single shared
`docs/knowledge/metrics/apple-log.json`, which caused merge conflicts on
every PR that wrote a handoff. The intended per-session-file approach never
made it in.

### Files changed

| File                                          | Change                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agent-os/policies/complexity-policy.md` | Replaced "Recording in `apple-log.json`" section with per-session file instructions; clarified why                                      |
| `scripts/agent/docs/apple-calibration.ts`     | Now reads from `docs/knowledge/metrics/apples/*.json` (new dir) **and** legacy `apple-log.json`; deduplicates by session key (dir wins) |
| `.github/copilot-instructions.md`             | Updated inline reference from "append to apple-log.json" to "create individual file in apples/"                                         |
| `docs/knowledge/metrics/apples/.gitkeep`      | Created new directory for per-session entries                                                                                           |

### New convention

Going forward, at the end of each session create:

```
docs/knowledge/metrics/apples/YYYY-MM-DD-<slug>.json
```

with a single JSON object (same schema as before). The legacy
`apple-log.json` is still present for historical data and still read by the
calibration script.

## No follow-up needed

The calibration script deduplicates so existing `apple-log.json` entries and
any new per-session files will coexist cleanly.
