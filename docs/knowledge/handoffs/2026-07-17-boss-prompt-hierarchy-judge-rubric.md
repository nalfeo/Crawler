# Design-language priority hierarchy + theme-adherence judge rubric + cactusfolk fix

## Systems touched

sprite-pipeline, sprite-workflow

## Context

Recovery session for a stalled "Approve stalled session" task that had originally
investigated a Floor 2 boss sprite A/B test (five family bosses). The prior
session hit the CAPI 5MB request limit after embedding a large sprite-sheet
report and could not compact; its code work was safely committed at `eab9e33c`.

The user's original unanswered question — "these are similar enough before/after
that I'm dubious the new prompts were used" — was answered: the revised Floor 2 +
family addenda **were** present in the composed prompt, but were structurally
losable (no explicit conflict-priority rule, no dedicated judge axis to catch a
sheet that ignores them). Follow-ups narrowed to cactusfolk specifically ("Abuela
Saguaro" not reading as a grandmother) and converged on three fixes.

## What changed

1. **Explicit conflict-resolution hierarchy** (`scripts/sprites/content-direction.ts`,
   `designLanguageAddendaBlock()`): when theme/floor/general Crawler design
   language addenda conflict, the composed prompt now states the priority order
   explicitly: **theme > floor > general Crawler design language**. Reworded (this
   session) from an earlier ALL-CAPS/imperative draft to conversational,
   goal-oriented phrasing to avoid tripping Azure's jailbreak-shape content
   classifier (`docs/agent-os/sprite-style.md:149-171`) — the exact
   priority-order substring asserted by tests is preserved.
2. **New `themeAdherence` judge rubric axis** (`scripts/sprites/judge.ts`): a 5th,
   conditional evaluator (active only when a theme/floor addendum is present) so a
   sheet that ignores the addendum fails review instead of passing on the 4
   generic axes. `PROMPT_TEMPLATE_VERSION` bumped to `v5` to invalidate stale
   judge-response cache. Fixed a plan-review-caught bug where `buildUserPrompt()`
   hardcoded "four scores" text even when the 5th axis was required.
3. **Cactusfolk "Abuela Saguaro" addendum cleanup**
   (`scripts/sprites/design-language-addenda.ts`, `briefs/enemies/cactusfolk-boss.yaml`):
   added concrete grandmother visual cues (stooped/hunched posture, deeply
   wrinkled/weathered flesh, wire-rimmed spectacles, faded floral rebozo) in place
   of vaguer "matriarch" language; de-capitalized/softened imperative phrasing for
   the same jailbreak-classifier reason as #1.

## Review harness (3🍎)

- Plan review (gpt-5.4): `approved_with_changes`, 5 concerns (1 blocking — the
  `buildUserPrompt` bug above), all 5 resolved (see ledger notes for the 2
  non-blocking concerns resolved by inspection/programmatic check rather than
  code change: recency-bias positioning already favors theme via block ordering;
  all-17-families addendum coverage verified for all 72 family-bearing floor-2
  archetype ids — zero missing).
- Code review (claude-sonnet-4.6): clean, no issues.
- Ledger: `docs/knowledge/review-ledgers/2026-07-17-boss-prompt-hierarchy-judge-rubric.review-ledger.json`,
  validated.

## A/B test evidence (observe-before-done)

CI could not validate the unmerged fix branch (see finding below), so the exact
one-liner→brief→sheet pipeline function (`runIssuePipeline`, the same function
the `asset-request` worker calls) was invoked directly, locally, against real
Azure providers on this branch's code. Full evidence:
`C:\Users\nalfeo\.copilot\session-state\7a53850f-668b-41d7-9a8f-62193ee70645\files\abuela-fix-ab-test-report.md`
(session-local, not committed — contains no images/base64/giant JSON).

Summary: all 4 generated variants for `cactusfolk-boss` scored `themeAdherence:
5/5`, with judge rationales explicitly citing the fixed addendum's grandmother
cues (floral rebozo, wire-rimmed spectacles, wrinkles, spines). The freshly
promoted brief (`briefs/draft/enemies/cactusfolk-boss.yaml`, gitignored) was
newly synthesized (not reused) and already reflects the grandmother cues. The
reconstructed composed prompt (via `buildSheetPrompt()`, since exact provider
payloads are not persisted as run artifacts) confirms the hierarchy paragraph and
softened phrasing landed correctly.

## Noteworthy finding (not fixed, reported)

`.github/workflows/asset-request.yml` cannot validate an unmerged branch's
prompt/judge changes against a real GitHub issue: issue-triggered events
(`labeled`/`edited`/`reopened`) always run on the **default branch**, and the
workflow's `concurrency` group serializes runs, so an auto-triggered `main` run
typically drains the fingerprint-deduped queue item before a concurrent
`workflow_dispatch --ref <feature-branch>` gets its turn. No `workflow_dispatch`
input exists to target a specific issue. The only way to A/B test an unmerged
sprite-pipeline branch against real Azure output is a local direct invocation of
`runIssuePipeline()` (or equivalent), as done in this session. Worth a future
session adding either a `workflow_dispatch` issue-number input or documentation
warning future sessions away from this race.

## Verification

- `npm run typecheck` — clean
- `npx eslint` on all changed files — clean
- `npm run test:sprites` — 1280 passed, 1 skipped
- `npm run verify:fast` — 620 unit tests passed, all coverage checks OK
