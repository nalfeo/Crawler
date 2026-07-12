# Session Handoff: Floor-1 AI runner park watchdog guard (issue #652)

## Date

2026-07-11

## Persona(s) adopted

QA — this session only added a regression guard (no behavioral code changes). Apple
estimate: 🍎 (1 apple).

## Routing verdict

✅ Right call — the win-rate acceptance criterion was already met by prior sessions;
only the guard test was missing.

## Apples

Estimated: 🍎 x 1
Actual: 🍎 x 1
Verdict: 🎯 Exact

## What Was Done

Addresses issue #652: "Headless AI runner gets stuck exploring/wiggling → Floor 1
win-rate capped at ~75%."

**Win-rate status (audited first):**

- Seeds 1–20 × {sword, bow, baseball-bat} — current result: **54/60 = 90.0%**,
  exactly meeting the ≥ 90% acceptance criterion.
- Remaining 6 failures are combat deaths / a late-victory (seed 10 sword, 386 s),
  NOT exploration stalls. The previous nav-wedge fix (PR #680, 2026-07-02) and the
  safe-room-exit / detour-hysteresis improvements already moved the needle from
  75% → 87.5% → 90%.

**New regression guard added:**
`tests/headless/floor1-park-watchdog.test.ts` (42 tests)

Coverage:

- **Seeds 1–20 × sword** — bounded 12 000-frame (~200 s game time) budget per seed.
  Asserts `longestWiggleMs < 45 s` and `longestStuckMs < 30 s` per seed.
  Explicit `beforeAll` timeout of 10 minutes to survive slow CI runners.
- **Extended (seed, weapon) pairs from the issue repro table** — seeds 2, 13, 15, 17
  × {bow, baseball-bat}. This matrix enforces both wiggle and stuck ceilings on
  the known repro cluster's cross-weapon axis. Also includes seed 8 × bow as the
  current worst post-fix wiggle hotspot.

Thresholds:

- `MAX_WIGGLE_MS = 45 000` (45 s) — sits far below the pre-fix worst cases (194 s
  seed 13, 338 s seed 15) while fitting the 200 s observation window for known
  ~150 s onset.
- `MAX_STUCK_MS = 30 000` (30 s) — the global dwell watchdog fires every 5 s
  (GLOBAL_DWELL_FRAMES = 300), so 30 s provides wide margin against the bug class
  while tolerating harvesting pauses.

## Runtime / real-artifact observation

Observed in the REAL headless AI pipeline (`src/game/ai/headless-runner.ts` via
`npm run ai:winrate-sweep` and `npx vitest run --project headless`):

- Winrate sweep (seeds 1–20, 3 weapons, 23 760-frame budget): 54/60 = 90.0%.
  Failures are combat-related, not exploration stalls.
- `tests/headless/floor1-park-watchdog.test.ts`: 42/42 passing (328 s wall time).
- `npm run verify:fast`: 85 test files / 1155 tests — all passing.

## What's Next

- Seed 8 bow (timeout at 396 s, 12 kills, 0 levels, ENGAGE 47.6%, worst wiggle
  33 s) is a known edge-case failure: the AI engages correctly but dies without
  leveling. Not an exploration stall — separate root cause (likely bow kite
  distance vs. enemy density on this seed). Tracked as a follow-up if the
  win-rate target is raised above 90%.
- If the win-rate target is raised to 95%+, seeds 8/10/18/12 need investigation.

## Blockers

None.

## Branch State

- Branch: `copilot/fix-ai-runner-exploring-issue`
- PR: #1056 (closes issue #652)
- All tests passing: yes.

## Systems touched

ai-pathfinding

## Test Results

- `npx vitest run --project headless tests/headless/floor1-park-watchdog.test.ts` → 42/42 pass (328 s)
- `npm run verify:fast` → 85 test files / 1155 tests — green
- `npm run ai:winrate-sweep -- --seeds 1-20` → 54/60 = 90.0% (meets target)
