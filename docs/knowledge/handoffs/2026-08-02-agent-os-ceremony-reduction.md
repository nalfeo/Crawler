# Handoff: Agent-OS Ceremony Reduction

**Date:** 2026-08-02
**Session slug:** agent-os-ceremony-reduction
**Apple estimate:** 🍎🍎🍎 (tooling-only cap)
**Status:** Implementation complete, PR ready for review

## Systems touched

agent-tooling

## Task

Five-part process-reduction ask: drop 1–2🍎 review ledgers, delete the
`authoring-main-sync` guard, delete the stale current-state memory file, dedupe
the triplicated agent instructions, and add an independent grader for 3+🍎.

## Why this was worth doing

693 committed review ledgers, distribution `{1: 90, 2: 251, 3: 238, 4: 83, 5: 31}`.
**341 of them (49%) are 1–2🍎 ledgers requiring zero review stages** —
content-free files that existed only to satisfy the `pr-review-ledger` guard's
missing-file deny. Half the ledger corpus was pure paperwork.

## What was done

### 1. Dropped the 1–2🍎 ledger requirement

`requiredStagesForApples()` already returned `[]` for 1–2🍎; only the guard's
missing-file deny forced the file to exist. That branch in
`.github/extensions/copilot-guards/guards/pr-review-ledger.mjs` now returns
`allow` with `additionalContext` (`missingLedgerReason` → `missingLedgerNotice`).

**A present-but-incomplete ledger still hard-denies** — that is the case that
actually matters.

### 2. Deleted `authoring-main-sync`

Guard file, test file, `config.json` entry, and `extension.mjs` registration
removed. `trackAuthoringActivity()`, the `timestamp()` helper, three interval
constants, and the `activeAuthoringMs`/`lastActivityAt` state fields removed
from `scripts/agent/sync-main.mjs`. **`attemptMainSync`, the manual
`npm run sync:main` CLI, and the `preflight.sh` session-start call are intact.**

### 3. Deleted the current-state snapshots

`docs/knowledge/memory/current-state.md` (dated 2026-06-26) and its stale
sibling `current-state-2026-07-03.md`. Neither was referenced by any script;
both were point-in-time notes masquerading as live status. Back-links removed
from `memory/README.md` and `project-overview.md`, and the README now states
explicitly that the KB records **durable** facts only — live status belongs in
dated handoffs.

### 4. Deduped the agent instructions

`AGENTS.md` is now the single canonical agent contract.
`.github/copilot-instructions.md` is now a compact pointer file with
a "where each rule lives" table. Content unique to the old copilot-instructions
(Project Context, Test Strategy, PR-review contract, the draft-PR merge bullet,
the ECS system shape, the no-Phaser-in-core note, apple accounting) was folded
into `AGENTS.md` first — **no rule was dropped or weakened**, verified by
grepping every distinctive phrase.

**`scripts/agent/docs/check-session-instructions.ts` was mandating the
duplication.** It required six policy bullets to be mirrored verbatim in both
files. Inverted: it now asserts the bullets exist in `AGENTS.md`, that the
pointer file links to `AGENTS.md`, and that the pointer file does **not**
restate them — so the triplication cannot creep back.

### 5. Independent grader for 3+🍎

Implemented as a **pre-PR gate** (option (a) of the plan's blocking question,
per my stated recommendation — the human never explicitly answered, flag this
if (b) was wanted).

- `scripts/agent/review/grader.mjs` — the deterministic half: `collectDiff`,
  `buildGradingPacket`, `parseGradeResponse`, `applyGradeToLedger`. All git
  access goes through an injectable `runGit` for testability.
- `scripts/agent/review/grade-cli.mjs` — `npm run review:grade -- prompt <ledger>`
  and `record <ledger> --model <m> --file <p>`.
- `independent_grade` is a required stage at ≥3🍎, validated like the others.

## Load-bearing details

- **The trade-off item 1 forces.** The apple tier is only readable _from_ a
  ledger. Once 1–2🍎 changes stop committing one, a _missing_ ledger cannot be a
  hard gate — a skipped 4🍎 ledger is indistinguishable from a legitimate 1🍎
  change. The ≥3🍎 ledger is therefore now an **artifact-trust** gate (same
  model as handoffs), and `independent_grade` is the compensating control.
  Documented in the guard header, the policy doc, and SKILL.md.
- **Schema-version gating is what protects the 693-ledger corpus.**
  `independent_grade` is required only when `schema_version === 'review-ledger/v2'`.
  Verified empirically: the validator reports **exactly 81 invalid ledgers both
  before and after** this change. (Those 81 are pre-existing failures from
  earlier policy tightenings — mostly missing `plan_divergence`.)
- **The grader deliberately does not call a model API.** Like every other
  harness stage, the agent dispatches the model via `task` with an explicitly
  different model; `grader.mjs` owns only the deterministic, unit-testable half.
- **`parseGradeResponse` recomputes the verdict** rather than trusting the
  model: any criterion < 3 or any `blocker` finding forces `verdict: 'fail'`.
  Rule #11 applied to graders — a hedging grader cannot soften the gate.
- **Independence is machine-checked.** `priorReviewModels()` collects the plan
  reviewer, dual-plan models + judge, every code-review/multi-model round model,
  and the adjudicator; a `grader_model` among them is rejected.
- **`head_sha` binds a grade to a tree** so a grade cannot be carried silently
  across a branch rewrite.

## Independent code review (gpt-5.6-sol) — 5 findings, all fixed

The grader I built was itself the least-reviewed thing in the change, so I ran a
separate-model code review over the diff. It found five real holes, every one of
them in the _new_ enforcement code. All are fixed with regression tests:

1. **A new ≥3🍎 ledger could declare `review-ledger/v1` and skip
   `independent_grade` entirely** — the v2 gate keys off the _declared_ version.
   Fixed: v1 is now accepted only for ledgers dated before
   `SCHEMA_V2_CUTOVER_DATE` (`2026-08-03`, the day after the stage landed so
   ledgers already written by in-flight sessions on the cutover day survive).
2. **`verdict: "pass"` was accepted alongside criteria below 3.** The verdict
   recomputation lived only in the CLI, but the guard trusts the _validator_.
   Fixed: `validateIndependentGrade` re-derives the same rule.
3. **Findings were counted, never schema-validated**, so `severity: "BLOCKER"`,
   a bare string, or a missing severity was a finding but not a blocker —
   a blocker-detection bypass. Fixed: findings are schema-validated in both the
   grader and the ledger validator, `findings` is persisted, and `pass` is
   rejected alongside any listed blocker.
4. **`head_sha` accepted any non-empty string** (`"not-a-sha"` validated).
   Fixed: must be a 7–40 char hex object id.
5. **Independence was checked against reviewers but not the author** — the
   implementer could grade its own work. Fixed: `implementer_model` is a
   required field and must differ from `grader_model`; `--implementer` is a
   required `review:grade -- record` flag.

Residual gap worth knowing: `head_sha` is validated as _well-formed_, not as an
ancestor of HEAD covering the current code. The guard runs sandboxed without git,
so binding a grade to the tree it actually graded needs a git-side check
(prereq-script or CI). Follow-up, not a blocker.

## Validation

- `scripts/agent/review/*.test.mjs` — 194/194 pass (41 new)
- copilot-guards suite — 170/170 pass
- Historical corpus: **81 invalid before and after** (identical), across all 693
  ledgers — zero retroactive invalidation, re-verified after the hardening
- `sync-main.test.mjs` — 3/3
- `npm run test:guards` — 2297 pass; the 41 failures are all
  `.github/extensions/sprite-editor/tests/*` and reproduce identically on a
  stashed baseline (Playwright browser not installed in this sandbox)
- `npm run docs:check` — 0 blocking
- `npm run lint`, `npx prettier --check` — clean

## Follow-up completed after review feedback

The extension bare-import issue called out in review feedback is now fixed:
`.github/extensions/asset-search/lib/index-builder.mjs` switched the `yaml`
import to `createRepoRequire(...)`, matching extension policy.

## Follow-ups

- Bind `head_sha` to the tree it graded (ancestor + no code changed since) in a
  git-capable context — see the residual gap above.
- The first real ≥3🍎 session after this lands exercises `review:grade` end to
  end for the first time; watch for prompt-size issues on large diffs
  (`DEFAULT_DIFF_CHAR_LIMIT` truncates).
- Consider a periodic sweep that re-grades merged PRs to accumulate scores in
  `docs/knowledge/metrics/` — i.e. option (b) _in addition to_ the gate, which
  would make review-harness effectiveness measurable.
