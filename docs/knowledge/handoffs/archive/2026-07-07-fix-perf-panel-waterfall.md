# Session Handoff: Agent Perf Panel — true shared-axis waterfall + context-window pressure strip

## Date

2026-07-07

## Persona

Producer (tooling/devtools change, self-driven review harness)

## Systems touched

devtools

## Apples

3🍎 estimated, 3🍎 actual (exact — waterfall fix was ~2🍎, the honest context-pressure strip added ~1🍎 of design/pairing/alignment work)

## What Was Done

Two related fixes to the `agent-perf-panel` canvas extension
(`.github/extensions/agent-perf-panel/`):

1. **Waterfall was not a waterfall.** The old `viewWaterfall` drew per-turn,
   re-normalized strips with no shared time axis, so bars couldn't be compared
   across turns. Replaced with a pure `buildWaterfall()` that lays every tool
   span on one shared wall-clock axis (`rows` with `leftPct`/`widthPct`,
   `turnBands`, `ticks`), plus a rewritten client renderer + CSS. Span math is
   split into `actualSpanMs = max(0, t1-t0)` (reported/`spanMs`, ticks) vs
   `layoutSpanMs = max(1, actualSpanMs)` (pct denominator only) so a 0ms span
   can't divide-by-zero, and all pcts are clamped 0..100. All timestamps are
   canonicalized through `Number.isFinite` before sort/map.

2. **Context window size over time (honest).** The CLI event log does **not**
   record running context size — per-call input/cache tokens are 0 everywhere;
   the only real context samples are at compactions (`compactions[].preTokens`
   - `.ts` + `.by`) with the system/conversation/toolDefinitions breakdown
     living only in `contextEvents` `compaction_start` entries, against a
     `modelContextBudget` ceiling (which can be exceeded before compaction). So
     rather than fabricate a continuous line, `buildContextPoints()` emits
     **discrete lollipop samples** (stems + knobs, NO interpolated polyline) on
     the same shared axis as the waterfall, with a dashed budget line,
     over-budget dots drawn above it, off-axis flagging, and an honest
     empty-state note for 0-compaction sessions. The context chart + axis ruler
     sit in a single sticky `.wf-head` inside the shared `.wf-scroll` flex column
     so x-alignment with the lanes is structural, not hand-computed.

**Observed in the running extension (real artifact — this is a devtools canvas,
not a game system):** verified live via a throwaway HTTP harness that imports
the real extension modules + chrome-devtools against **real** session data —
`d77f413a` (25 compactions, peak 269198 > 200000 budget): before = flat
per-turn strips, no context info; after = shared-axis lanes with the context
strip above them, red over-budget dots above the dashed budget line, "269K"
peak label, and the `.wf-head` staying pinned across a 400px scroll.
`f682c880` (86 rows, 0 compactions): after = honest empty-state note renders
above intact lanes.

Tests grew 28 → 44 (all pass). `verify:fast` and full `verify` pass (headless
Floor-1 gate deferred to CI as normal; review-ledger prereq green).

## Key Decisions Made

- **Never fabricate a context line.** The maintainer explicitly chose the
  honest compaction high-water-mark + budget-ceiling representation over any
  synthesized continuous curve. Discrete samples only; the gaps are the truth.
- **FIFO breakdown pairing is gated on `by === 'auto'`.** Only auto-compactions
  (`session.compaction_complete`, pushed with the literal `by:'auto'`) are
  preceded by a `compaction_start` carrying the breakdown; truncations
  (`session.usage_info`, `by: truncationPerformedBy || 'unknown'`) never emit
  one. Gating consumption on `by==='auto'` stops an interleaved truncation from
  greedily stealing an auto-compaction's breakdown. (Found in code review;
  fixed + regression-tested.)
- **Structural x-alignment.** The context chart and lanes share one flex column
  inside `.wf-scroll` rather than aligning via computed offsets, so the axes
  cannot drift.

## What's Next / Blockers

No blockers. Ready to commit + PR (waterfall fix + context strip as one 3🍎
change). Possible future polish: (a) if the CLI ever starts logging running
context size per call, the discrete strip could become a real continuous line;
(b) surface truncation vs auto-compaction distinctly in the legend, not just
via `by` in tooltips.

## Retrospective

### Lessons Learned

- The worktree had **no `node_modules`** — `npm ci` is required before any
  `verify:*` (installs the tsc/lint toolchain + playwright chromium in
  postinstall, ~47s).
- Run the extension's own tests with a **quoted glob** from repo root:
  `node --test ".github/extensions/agent-perf-panel/tests/*.test.mjs"` (NOT
  `node --test tests/`). Needs Node 24+ for `node:sqlite`; env has v24.15.0.
- `aggregator.mjs` imports `analyzer.mjs`, so a parse error in analyzer fails
  **both** test files at module-link time with a misleading
  `SyntaxError: Unexpected token '?'` at the first optional-chaining token —
  that error means "this file didn't parse", not "old Node". `node --check
<file>` pinpoints the real line fast.
- The SPA reads the session only from the URL hash at load, so after changing
  `#session=…` you must **hard reload** (ignoreCache) or it keeps the prior
  session.

### Mistakes Made

- When applying the code-review fix via `edit`, my `old_str` stopped at
  `const breakdown = cand` and did **not** include the trailing
  `? {...} : null; … points.push(...); }` — so the replacement **duplicated**
  the loop tail and produced a syntax error (`? {` at column 0). Early signal:
  a `SyntaxError` at a `?` on a line I didn't think I touched, in a file that
  compiled seconds earlier. Lesson: when an `edit` rewrites the _middle_ of a
  block, make `old_str` span the whole block (through its closing brace), or
  re-view the region immediately after and `node --check`.

### Opportunities for Future Improvement

- The manual visual-verify harness (imports extension modules + replays HTTP
  routes) is re-created ad hoc each session. A committed, parameterized
  dev harness for canvas extensions (point it at a repo + session id) would
  make "observe before done" cheaper and repeatable for future extension work.
- Consider a tiny deterministic snapshot test over `renderHtml` output for the
  context strip (structure only) so the honest-empty-state and stems-only
  guarantees are locked without a browser.
