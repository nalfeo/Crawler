# Handoff — Send our own approved sprites as generation references, retire Kenney (2026-07-03)

## Why

The sprite-generation prompt told the Azure OpenAI `images/edits` (gpt-image-1)
endpoint to match the style of specific on-disk reference PNGs — and those
reference images were the **Kenney placeholder** spritesheets we ship as
temporary art. So every generation was literally anchored to placeholder art we
are trying to replace. The user asked to **stop sending placeholders** and
instead send **our own highest-quality generated sprites**, with some injected
randomness, biased toward **same-type** examples (a lamp request pulls other
`item`s; ice tiles pull other tiles) so the model learns from art that is both
ours and on-concept.

## What shipped

A deterministic, `SeededRandom`-seeded weighted reference **selector** that, at
generate time, samples our own approved generated sprites from the generated
manifest — favoring the subject brief's `type`, broadening within **our** art
(never Kenney) when the same-type pool is thin, and recording the chosen
references in the run summary. Kenney is fully retired from the generation
reference path.

### Design decisions (locked with the user)

- **Q1** — Add a `type` field to manifest entries + a full backfill of existing
  entries (heuristic + overrides).
- **Q2** — When the same-`type` pool is thin, broaden **within our own art**;
  **never** fall back to Kenney.
- **Q3** — Selection happens at **generate time**, seeded from `brief.name` so a
  rerun of the same brief is reproducible; the chosen references are recorded in
  the `RunSummary`.
- **Q4** — Bias on **`type` only** (no separate "theme" dimension for now).

### Files

- **`scripts/sprites/reference-selector.ts`** (NEW) — pure deterministic weighted
  sampler. `selectReferences`, `toEligible`, `referenceSelectorSeed`,
  `parseJudge`. Constants: `SELECTOR_VERSION='v1'`, `REFERENCE_COUNT=3`,
  `SENSOR_FLOOR=0.75`, `JUDGE_FLOOR=3`, `WEIGHT_FLOOR=0.05`. Eligibility:
  not-placeholder, self-exclusion by briefId, `isSafeGeneratedAssetPath`, typed,
  `sensorRatio ≥ 0.75`, judge null-allowed OR **strict integer** 1–5 with ≥3.
- **`scripts/sprites/generated-asset-path.ts`** (NEW) — the load-bearing "our art
  only" guard. Pure `isSafeGeneratedAssetPath` (rejects absolute / backslash /
  `..` / `.` / empty / NUL / non-png; requires `generated/` prefix) + impure
  `assertResolvedUnderGenerated` (path.relative containment). **Do not weaken.**
- **`scripts/sprites/load-reference-pngs.ts`** (NEW) — `loadRecordedReferencePngs`
  for the rejudge/regenerate path: reads the references recorded on a prior run
  through the same path-safety guard (no re-selection, so a rejudge is faithful).
- **`scripts/sprites/backfill-manifest-types.ts`** +
  **`backfill-manifest-types-cli.ts`** +
  **`manifest-type-overrides.json`** (NEW) — `resolveManifestEntryType` cascade
  (explicit → override → brief prefix heuristic → `unknown`). Prefix-slice
  dash-guard fixed so a dash-less briefId (`tile`) resolves correctly.
- **`src/shared/sprite-types.ts`** (NEW) — shared `SpriteType` enum + `isSpriteType`
  used by both the manifest schema and the selector.
- **`scripts/sprites/generate-one.ts`** — wires selection in: `loadReferenceCandidates`
  (reads the generated manifest; **returns `[]` when the manifest file is absent**
  so a cold start fails closed with an actionable error instead of ENOENT),
  pre-filters with `isSafeGeneratedAssetPath`, calls `assertResolvedUnderGenerated`
  before `readReference`, and **throws an actionable error on zero eligible
  references** (the edits endpoint requires ≥1 image, so this is correct — see
  below).
- **`scripts/sprites/run-artifacts.ts`** — `referenceSprites` recorded in `RunSummary`.
- **Kenney retirement** — `synthesize-brief.ts`, `synth-cli.ts`,
  `provider/azure-chat-synth.ts`, `provider/synth-types.ts`, `brief-schema.ts`,
  `judge.ts`, `approve.ts`, `sidecar/server.ts`, the six `data/sprite-types/*.json`
  per-type defaults, `docs/agent-os/sprite-style.md`, `briefs/README.md`. Deleted
  `scripts/sprites/reference-allow-list.ts` + its test.
- **Tests** — NEW `reference-selector.test.ts`, `generated-asset-path.test.ts`,
  `backfill-manifest-types.test.ts`, `load-reference-pngs.test.ts`; NEW shared
  fixture `tests/fixtures/sprites/seed-generated-reference.ts` wired into
  `seed-run.ts` + 4 direct-`runFull` integration harnesses; updated
  `generate-one.test.ts`, `synth-to-generate.test.ts`, and the synth/brief unit
  tests.

## Observe before done

This is a pipeline/behavior change, so the observation is in a **real generate
pipeline artifact**, not a lab. `tests/integration/generate-one.test.ts` drives
the real `generateOne` (load brief → build prompt → select references → mock
provider capturing the request) and asserts:

- **Before** (implicit / retired behavior): generation anchored to Kenney
  placeholder reference PNGs.
- **After**: `req.referencePngs.length === 3`; **every** captured buffer resolves
  to a path under `public/assets/generated` and **none** contains `kenney`
  (`generate-one.test.ts:318–322`); the chosen `referenceSprites` all
  `startsWith('generated/')` and none contain `kenney` (`:336–337`). A separate
  case re-asserts no-Kenney bytes reach the provider (`:372`).

The `images/edits` endpoint (`scripts/sprites/provider/azure-openai.ts`)
**requires ≥1 `image[]` part**, so zero-reference generation is physically
impossible — the zero-eligible fail-closed guard is therefore correct and must
not be weakened (project rule #12).

## Verification

`npm run verify` green: typecheck, lint, format, dead-code, guard + review-ledger
tests, **788 sprite unit tests**, **72 integration tests** (the 34-test
missing-manifest regression I introduced mid-session is fixed — see below),
build. Headless Floor-1 gate deferred to its CI job (no `src/core` /
`src/game/ai` / balance touched). `verify:pr-prereqs`: review ledger valid; the
only remaining gate was this handoff.

Mid-session regression + fix (`fbd61254`): retiring Kenney made `generateSheetCore`
depend on a populated generated manifest, so 34 integration tests that drive the
real `runFull` failed with ENOENT. Fixed two ways — production
`loadReferenceCandidates` now returns `[]` (→ actionable fail-fast) when the
manifest file is absent, and the shared `seedGeneratedReference(root)` fixture
seeds one eligible weapon-typed reference into every real-`runFull` harness.

## Review harness

**4🍎 → full harness.** Ledger:
`docs/knowledge/review-ledgers/2026-07-03-sprite-reference-selector.review-ledger.json`
(validates: valid 4-apple ledger).

- **plan_review** (gpt-5.4): rejected → 8 concerns (5 blocking), all adopted.
- **dual_plan_synthesis**: plans by gpt-5.5 + gemini-3.1-pro-preview, judged by
  claude-opus-4.8 → pool-first same-type selector, ignore `brief.references`,
  fail-fast on zero eligible.
- **code_review** (loop, 4 rounds, clean): R1 3 models → 4 concerns fixed
  (`d9df6432`); R2 → residual judge-parse leniency fixed (`e27e612c`); R3 clean;
  R4 (2 distinct models) re-reviewed the regression fix — clean.
- **multi_model_review** (adjudicator claude-opus-4.8, 4 rounds, clean): R1 5 raw
  → 4 valid (generation & rejudge path traversal, malformed judge floor, backfill
  slice); R2 1 valid; R3 clean; R4 clean on `fbd61254`.

All 4 originally-adjudicated concerns: (1) generation-side path traversal
`generated/../kenney/...`, (2) rejudge-loader path traversal, (3) malformed
non-null `judgeScore` passing the quality floor (incl. the `parseInt`-leniency
residual), (4) backfill dash-less prefix-slice bug. All fixed with regression
tests; the `generated-asset-path.ts` guard was pronounced robust on Windows by
both reviewers.

## Follow-ups

- **Theme/palette dimension** (Q4 deferred): selection biases on `type` only. A
  later pass could add thematic alignment (e.g. ice tiles → other ice tiles)
  once we have a palette/theme tag on manifest entries.
- **Backfill coverage**: `resolveManifestEntryType` leaves genuinely-ambiguous
  entries `unknown`; those are simply lower-weight in the same-type pool. Add
  overrides to `manifest-type-overrides.json` as new concepts land.
- Selection currently reads the committed `public/assets/generated/manifest.json`
  at generate time; keep it backfilled/committed so the eligible pool stays warm.
