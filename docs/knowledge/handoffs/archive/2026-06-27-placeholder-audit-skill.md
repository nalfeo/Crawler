# Session Handoff: placeholder-audit skill

## Date

2026-06-27

## Persona(s) adopted

**Producer** (toolsmith/devops slice). A focused, self-contained tooling task —
no cross-layer coordination needed — so the Producer owned it end to end with a
DevOps-Engineer mindset (CLI + npm script + tests + skill doc).

## Routing verdict

✅ right persona — single-owner tooling work; DevOps-Engineer specialist could
also have fit, but the scope was small enough that Producer carried it directly.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — the two pure/IO modules were pre-written and import-verified,
which removed the hard logic, but the comprehensive 28-test suite, the SKILL.md,
two real lint fixes, and full verification balanced it back to a solid Medium.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Shipped the `placeholder-audit` skill: a deterministic tool that, after new
sprite art lands, finds placeholders a real generated asset could now replace.

- **`scripts/sprites/placeholder-audit.ts`** (pure, no IO) — copied in:
  `normalizeConcept`, `isPlaceholderManifestEntry`, `isPlaceholderSpriteNote`,
  `buildPlaceholderAudit`, plus the report/concept types. Collapses
  `enemy.`/`npc.`/`item.` prefixes and `-var-N`/`-vN`/`-placeholder` suffixes so
  a placeholder and its real `-v1` asset land on one concept.
- **`scripts/sprites/placeholder-audit-cli.ts`** (IO wrapper) — copied in:
  `parseArgs`, `collectNewAssetPaths` (git diff for `--since`),
  `runPlaceholderAudit`, table/json render, `main()`. Fixed two lint errors that
  the repo config caught (unused `ConceptAudit` import; missing `cause` on the
  re-thrown git-diff error per the `preserve-caught-error` rule).
- **`package.json`** — added
  `"sprites:placeholder-audit": "tsx scripts/sprites/placeholder-audit-cli.ts"`
  next to its `sprites:*` siblings.
- **`tests/unit/sprites/placeholder-audit.test.ts`** — 28 unit tests over the
  pure functions only (plain literals, no real manifest): every
  `normalizeConcept` suffix/prefix case, `isPlaceholderManifestEntry`
  (sourceRun/sensorScore/`-placeholder.png` + negative), `isPlaceholderSpriteNote`
  (temp-CC0 + undefined/empty), and `buildPlaceholderAudit`
  (replaceable/newContent/placeholderOnly bucketing, the `-vN` version-asymmetry
  collapse, `--since` scoping + `isNew` + `counts.newReplaceable`, the
  related-suggestion prefix heuristic, and deterministic sort order).
- **`.github/skills/placeholder-audit/SKILL.md`** — documents when to run it,
  the three placeholder sources, the `--since`/`--format`/`--all`/
  `--fail-on-replaceable`/`--manifest` flags, how to read each report section,
  and that related suggestions are heuristic (verify before wiring).

### Deterministic observation (rule #10) — CLI run against REAL repo data

`npm run sprites:placeholder-audit` (table):

```
Replaceable now: (none)
Real assets without a matching placeholder (new content):
  bent-pipe              bent-pipe-v1-var-1, bent-pipe-v1-var-5
  purple-potion-bottle   purple-potion-bottle-v1-var-4
  slime-king             slime-king-v1-var-4
  slime-queen            slime-queen-v1-var-0
Related name suggestions (heuristic):
  slime ~> slime-king   [placeholder: sprite-registry:enemy.slime] [real: slime-king-v1-var-4]
  slime ~> slime-queen  [placeholder: sprite-registry:enemy.slime] [real: slime-queen-v1-var-0]
Still on placeholder: 110 concept(s).
Totals: concepts=114 replaceable=0 new-real-assets=0 placeholder-only=110 related=2
```

Confirmed it classifies all three placeholder sources from live data:
manifest `*-placeholder` entries (e.g. `audience-rating-card`,
`glistening-rat-tail`), sprite-registry temp art (`enemy.slime` -> `slime`,
`enemy.rat` -> `rat`), and `mob-placeholder` mobs (`mob-def:slime-rat`); and the
real `-v1` generated assets present (`slime-king-v1`, `slime-queen-v1`,
`bent-pipe-v1`, `purple-potion-bottle-v1`). `--format json` emits the full
`PlaceholderAuditReport`. `replaceable=0` is correct: the real `slime-king`/
`slime-queen` assets are distinct concepts from the `slime` sprite-registry
placeholder, so they surface as new content + heuristic related-name links rather
than direct replacements.

## What's Next

- When wiring a real asset over a placeholder, re-run with `--since main` to scope
  to just-landed art, and treat the related-name section as leads to verify.
- Optional follow-up: a CI guard invoking `--since <base> --fail-on-replaceable`
  on sprite PRs so a landed asset that fully replaces a placeholder is flagged.

## Blockers

None.

## Branch State

- Branch: `nalfeo-placeholder-audit-skill` (off `main`; intentionally separate
  from bug-fix PR #419 — not stacked).
- All tests passing: yes (`npm run verify:fast` and full `npm run verify` both
  green).
- PR created: yes (see PR link in session).

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present — no telemetry section to paste.

## Test Results

- `npm run verify:fast` — typecheck + lint clean; 28/28 unit tests pass.
- `npm run verify` — all 8 steps green (typecheck, lint, format, dead-code,
  unit/integration/headless, build). Build succeeded; final test project 68/68.

## Key Decisions Made

- Kept the pre-written pure module's full public type surface
  (`ConceptAudit`, `RelatedSuggestion`, `PlaceholderAuditCounts`, etc.) even
  though knip flags some as unused exports — they are the documented JSON-consumer
  API and verify is non-gating on unused exports.
- Unit tests cover the pure layer only (the IO/CLI wrapper is exercised by the
  real-data observation run), per the tests-layer guidance and the creator's
  scope note.
