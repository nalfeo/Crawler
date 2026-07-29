# Session Handoff: Fix apple-calibration `Mean delta: NaN` (issue #335)

## Date

2026-06-27

## Persona(s) adopted

Producer → DevEx/Tooling. The task was an automation/health-script bug (the
nightly `docs-apple-calibration` check), not a game-systems change, so after the
Producer triage it routed to tooling/infra work on `scripts/agent/docs/`.

## Routing verdict

✅ right persona — the defect lived entirely in the docs/health tooling layer and
its metric data, which is DevEx/Tooling territory.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — testable lib extraction + script hardening + a 26-case unit
suite landed right where a Medium task should; the bulk of effort was diagnosis
(NaN root-cause + the dedup masking bug), which is normal for a 3.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Addressed the one genuine defect behind the issue #335 nightly-mutation report:
`docs-apple-calibration` printing `Mean delta: NaN` and an `undefined on-target`
verdict line.

- **Root cause**: historical apple entries (`apple-log.json` + many
  `apples/*.json`) use legacy shapes — field aliases (`estimate`/`estimated`,
  `actual`, `slug`), 🍎-emoji apple counts (`"🍎🍎"`), the `on-target` verdict,
  and sometimes no `delta`. The old script assumed the canonical schema and did
  no validation, so `undefined` fields propagated into the mean (→ `NaN`) and an
  unknown verdict rendered as `undefined`. It also deduped on a frequently-
  `undefined` `session` key, collapsing dozens of entries into one.
- **Fix** (durable, data-agnostic):
  - New pure module `scripts/agent/docs/apple-calibration-lib.ts` —
    `coerceApples` (number / numeric-string / 🍎-emoji), `verdictFromDelta`,
    `normalizeVerdict` (`on-target` → `exact`), `verdictEmoji` (with `❓`
    fallback), `normalizeEntry` (resolves every legacy shape, derives missing
    delta, returns `null` for unusable rows), and `computeCalibration` (always
    returns finite numbers).
  - Rewrote `scripts/agent/docs/apple-calibration.ts` to consume the lib: it
    normalizes every row, **warns + excludes** truly-unusable entries instead of
    poisoning the aggregate, and dedups by the _normalized_ session.
  - Added `tests/unit/apple-calibration.test.ts` — 26 cases across all exports,
    including a `fast-check` property test asserting the aggregate is never NaN.
- **Deliberately did NOT migrate the ~30 legacy data files**: the lib is
  designed (and documented) to tolerate legacy shapes at read time, so migrating
  is cosmetic, large, and risky. Today's sessions already write the canonical
  schema; the lib is the safety net for the historical tail.
- **Result**: `docs-apple-calibration` now reports `Mean delta: +0.00`,
  `Miss rate 0.4%`, `Calibration healthy` (1 info finding, 0 blocking) against
  the unmodified data. Full `npm run docs:check` exits 0.

The issue's other findings were already non-issues on `main`: the single
_blocking_ ADR finding (0014 → `floor1.json`) is already fixed (the ADR now
points at `floors/floor1.manifest.json`; `check-adr-consistency` reports 0), and
the rest were info-level.

## What's Next

- `docs-check-readme-commands` still reports **28 info findings** (undocumented
  npm scripts — doc drift). Non-blocking and out of scope here; a focused docs
  pass could sync the README script table.
- Optional: a one-off migration could rewrite the ~30 legacy `apples/*.json`
  entries to the canonical schema for on-disk consistency, but it has no effect
  on the report now that the lib normalizes them.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-apple-calibration-nan`
- All tests passing: yes (`npm run verify` green — 2384 unit + integration +
  headless + build)
- PR created: yes (closes #335)

## Agent-OS Telemetry

No `files/guard-telemetry.jsonl` present this session.

## Test Results

- `npm run verify:fast` — ✅ pass (typecheck + lint + 26 changed-unit tests)
- `npm run verify` — ✅ pass (typecheck, full lint, format, dead-code, 2384 unit
  tests, 49 integration, 68 headless, build)
- `npx tsx scripts/agent/docs/apple-calibration.ts` — ✅ `Mean delta: +0.00`, no
  NaN, no `undefined` verdict, 0 blocking
- `npm run docs:check` — ✅ exit 0 (0 blocking across all docs scripts)

## Key Decisions Made

- **Harden the consumer, don't migrate the data.** The fix lives in a tested,
  pure normalization lib that accepts legacy shapes, rather than a bulk rewrite
  of ~30 historical metric files. This permanently prevents NaN/`undefined`
  regardless of input shape, keeps the PR tight, and avoids transcription risk.
- **Extract pure logic to enable unit testing.** `apple-calibration.ts` calls
  `process.exit` at module load, so the maths were split into
  `apple-calibration-lib.ts` to be importable and testable without I/O.
- **Fix the dedup masking bug too.** Keying dedup on the normalized session
  (derived from `slug` when needed) stops dozens of legacy entries from
  collapsing onto a single `undefined` key (entry count 226 → 245).
