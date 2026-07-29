# Session Handoff: PR #370 review-thread follow-up — ADR-0005 + ADR index reconcile

## Date

2026-06-27

## Persona(s) adopted

**Producer** — took over a stalled PR-shepherding session for #370
("refactor: parameterize floor config to support multi-floor progression"). The
surface turned out to be docs governance (ADR index + ADR template conformance)
after the code/merge work was completed by others mid-session. No `src/` code
touched.

## Routing verdict

✅ reasonable — a multi-layer/ambiguous takeover defaults to Producer. In
hindsight a docs-focused persona would also fit, since the delivered change is
purely ADR documentation + index hygiene.

## Apples

Estimated: 🍎 x 3 <!-- declared at takeover, before any edits -->
Actual: 🍎 x 2 <!-- honest assessment at handoff -->
Verdict: 📈 Over — estimated 3 for a full 5-thread shepherd. The owner merged
#370 mid-session and PR #379 then realigned the flagged ADR path refs, so the
blocking work was done elsewhere. My shipped delta is a small, mechanical
docs-only diff (3 ADR files), though it took non-trivial diagnosis and two
re-scopes across a churning `main`.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Took over PR #370 in state OPEN + BLOCKED (5 unresolved Copilot review threads,
no auto-merge). The situation moved twice during the session:

1. **PR #370 was squash-merged by the owner** (`nalfeo`) at
   2026-06-27T05:31:49Z as `d77a5610`, before my thread fixes landed. The two
   _code_ refs the reviewer flagged (`src/lab-main.ts`, `scripts/agent/pr-lab-links.mjs`)
   had already been fixed on the head pre-merge.
2. **PR #379** ("docs: add #371 shepherd handoff and realign ADR paths after #370
   rename", `8e692117`) then landed and **already fixed the 10 broken ADR
   path references** the #370 rename introduced (across 0008, 0010, 0013, 0018,
   0019, 0024, 0025, 0026). After #379, `check-adr-consistency` on `main` was
   back to **0 blocking** (1 non-blocking WARN remaining).

That left a genuine, still-unfixed **delta on `main`**, which this follow-up
branch lands:

- **ADR-0005 `## Status` heading.** The owner had added
  `docs/knowledge/adr/0005-parameterized-floor-configuration.md` pre-merge (to
  satisfy threads about a missing ADR-0005 reference), but used an inline
  `**Status:** Accepted` metadata block. `check-adr-consistency` warns on the
  missing `## Status` heading. Converted the header to the house style
  (TEMPLATE.md: `## Status` / `## Date` / `## Estimated Complexity` / `## Deciders`).
  This clears the last finding — checker is now **0 findings, 0 blocking**.
- **ADR index README reconcile** (`docs/knowledge/adr/README.md`):
  - `0005` is no longer "intentionally unused" — it now points at the filed ADR.
  - **Fixed a latent collision trap:** "next unused number (currently **0028**)"
    was wrong because `0028-generated-sprite-variants.md` already exists on
    `main`; bumped to **0029** so the next agent doesn't create a duplicate 0028.
  - Added by-number table rows + thematic-index lines for both `0005` and the
    previously-unindexed `0028-generated-sprite-variants.md`.
  - Count `43 → 45`, range `0001–0027 → 0001–0028`.
- **ADR-0012 stale basenames.** Updated two `floor1Scenario.ts` →
  `floorScenario.ts` references (bare basenames, so not gate-blocking, but stale
  after the #370 rename; #379 left them untouched).

## What's Next

- Nothing blocking. If desired, a future sweep could update remaining _prose_
  mentions of pre-rename basenames in other ADRs (none currently fail the
  checker, since they are bare basenames without a path-like `/`).
- The two `0005`/`0008` handoffs that #370 carried
  (`2026-06-26-floor1-config-parameterization.md`,
  `2026-06-26-parameterize-floor-config.md`) remain on `main` as historical
  records; no action needed.

## Blockers

None. PR #370 itself is already merged (`d77a5610`). This branch is a docs-only
follow-up that completes the review-thread remediation #370's premature merge +
#379 didn't cover.

## Branch State

- Follow-up branch `docs-adr-0005-status-and-index` off post-#379 `main`
  (`8e692117`).
- Diff: 3 files — `0005-parameterized-floor-configuration.md`,
  `0012-multi-safe-room-and-npc-quest-callback-pattern.md`, `README.md`
  (24 insertions, 8 deletions).
- Gates green pre-push: `check-adr-consistency` 0 findings / 0 blocking,
  `check-paths` exit 0, Prettier clean on touched files, `verify:fast`
  (typecheck + lint) green. No `.ts`/code/config changed, so the code gates
  (tests, build, headless Floor 1 gate) are unaffected.

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — no guard telemetry to
report.

## Test Results

No `src/`, `tests/`, or `scripts/` files changed (ADR docs only). Relevant
gate is `npm run docs:check` — `check-paths` and `check-adr-consistency` both
pass with 0 blocking findings; the prior ADR-0005 `## Status` WARN is cleared.
Lab gate not applicable.

## Key Decisions Made

- **Did not reopen / re-fix the 10 ADR path refs** — PR #379 already realigned
  them on `main`; re-doing them would be redundant churn. Reset the follow-up
  branch onto post-#379 `main` and kept only the genuine delta.
- **Reconciled the existing ADR-0005 rather than renumber to 0028** — the owner
  already filed `0005` and the merged PR body references ADR-0005; `0028` is
  also already taken (`0028-generated-sprite-variants.md`). Renumbering would
  break inbound references and collide. Made `0005` valid + indexed instead.
- **Fixed the README "next unused 0028" pointer** while editing the numbering
  section, to prevent a future duplicate-0028 collision (low-risk, high-value
  per-byte).
