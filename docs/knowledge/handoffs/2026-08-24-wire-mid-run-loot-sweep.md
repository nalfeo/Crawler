# Session Handoff: Wire the mid-run loot sweep into the AI behavior tree

## Date

2026-08-24

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, loot-and-drops

## Apples

2🍎 estimated, 2🍎 actual (🎯 exact) — single-line wiring fix restoring an
already-tuned/measured behavior, plus targeted test coverage.

## Issue

Closes nalfeo/Crawler#3477 ("the ai player leaves so much trivial to grab xp
on the ground").

## What Was Done

Root-caused the issue to a wiring gap that has existed since the feature's
original PR (#2793, 2026-08-08): `buildLootSweepBehavior('mid-run')` — a
bounded (`LOOT_SWEEP_RADIUS_FT = 12`) post-combat cleanup sweep for XP/gold —
was fully implemented, tuned, and documented (ADR 0083, the
2026-08-08-loot-collection-efficiency handoff, and the `bt-ai-tuning.ts`
comment recording a 72-run measurement: "12ft -> ... 72/72 wins <- shipped"),
but the behavior tree only ever called the `'pre-exit'` window
(`this.buildLootSweepBehavior('pre-exit')`) at tree-build time. `git log -S`
across full history confirms the `'mid-run'` call site never existed in any
commit — the constant and guard logic were "shipped" in the tuning docs, but
the actual wiring line was dropped before merge.

Without the mid-run window, XP/gold dropped mid-floor was only picked up via:

- `Opportunistic Collect` (Track B) — only nudges the arc for loot directly
  ahead within a narrow travel corridor;
- `Collect` (Track A, Priority 5) — sits below `Engage`/`Hunt`, so it never
  gets a turn whenever another enemy is available to fight/hunt next, which is
  most of the time mid-floor.

Fix: added `this.buildLootSweepBehavior('mid-run')` next to the existing
`'pre-exit'` call at the same Priority 2.5 selector slot. The two windows are
mutually exclusive by the window guard already inside `buildLootSweepBehavior`
(`mid-run` fires only when the pre-exit window is _not_ open), so order
between them doesn't matter for correctness.

**Observed in the real artifact** (`npx tsx src/game/ai/headless-runner-cli.ts`,
not a lab): the official `tests/headless/floor1-completion.test.ts` win-rate
gate (25-seed panel) and `tests/headless/floor1-economy-gate.test.ts` both stay
green after the fix (4/4 and 5/5 respectively), and the
`floor1-throwing-knife11-release-regression.test.ts` regression test also
passes. An informal 8-seed × 3-weapon `combinedRatio` spot check showed no
consistent win-rate degradation; the only authoritative signal for Rule 12 is
the official gate suite, which is unchanged.

## Key Decisions Made

- Wired mid-run at the same priority slot as pre-exit rather than a new slot,
  matching the design already described in both call sites' doc comments
  ("Priority 2.5" is used by both).
- Did not touch `LOOT_SWEEP_RADIUS_FT` (12 ft) or `LOOT_SWEEP_PANIC_THRESHOLD`
  (0.5) — both already carry a justified 72-run measurement comment, and this
  fix is scoped to restoring the wiring, not re-tuning it.
- Updated `tests/unit/ai/bt-loot-sweep.test.ts`, whose docstring incorrectly
  asserted "the sweep fires as a pre-exit window only" — that was true of the
  shipped code, but not of the documented/intended design. Added a `mid-run
(local) window` describe block mirroring the existing pre-exit coverage
  (targets nearby loot, respects the radius bound, falls through with no
  loot).

## What's Next / Blockers

- No Floor-2-specific mid-run measurement exists (mirrors the "Floor 2 is
  unmeasured" gap already noted in the 2026-08-08 handoff); the window guard
  is floor-agnostic so it should behave symmetrically, but a dedicated
  Floor-2 sweep would confirm it.
- If a future session wants to raise `LOOT_SWEEP_RADIUS_FT`, it needs its own
  fresh 72-run gate-matrix measurement per Rule 12/ADR 0083 DEC-005 — do not
  reuse the numbers in this handoff for that purpose.

## Retrospective

### Lessons Learned

- An ADR/handoff claiming a knob was "measured and shipped" is not proof the
  wiring made it into the merged tree — `git log -S` on the exact call-site
  string is a fast, authoritative way to check whether a documented behavior
  was ever actually invoked, independent of what the surrounding prose claims.
- The existing `bt-ai-tuning.ts` comment block for `LOOT_SWEEP_RADIUS_FT` was
  itself the clearest signal pointing at the bug: it described a 72-run
  measurement and said "<- shipped", but the behavior it measured was never
  wired in. Tuning-constant comments are worth cross-checking against actual
  call sites whenever a bug report matches their description.

### Mistakes Made

- Initially ran an informal, non-canonical 8-seed spot check with a hand-rolled
  script that didn't match the official gate's default config (persona,
  settlement-return-routing), producing noisy `combinedRatio` deltas (including
  one seed that looked like a regression). Should have gone straight to the
  official `floor1-completion`/`floor1-economy-gate` suites as the
  authoritative signal instead of spending time interpreting ad hoc numbers.

### Opportunities for Future Improvement

- `lootEfficiency.combinedRatio` is not exposed through the CLI's printed
  summary output; a `--loot-summary` flag (or including it in the default
  console output) would make quick manual before/after checks like this one
  faster without needing a throwaway script.
