# Handoff: Theme-equipment review canvas ergonomics

**Date:** 2026-07-27
**Session slug:** theme-equipment-review-ergonomics
**Apples:** 3🍎 (tooling-only cap, AGENTS.md)

## Systems touched

sprite-workflow

## Summary

Six ergonomics fixes to the theme-equipment review canvas
(`.github/extensions/theme-equipment-review/`) and the durable review state
machine (`scripts/sprites/theme-equipment-set.ts`). The maintainer was being
stalled by a treadmill: approving the set-level "collection" and then reviewing
items one at a time silently wiped the collection approval, and there was no way
to bulk-approve or hand-edit a brief. A fifth fix closes the loop so bulk-approve
no longer dead-ends at a locked Advance with no explanation; a sixth scopes the
phase advancement controls to the active phase's own tab.

## The changes

1. **An up-vote no longer invalidates the collection.** `applyThemeSetItemReview`
   previously reset `state.phases[phase]` (both `collectionJudge` and set-level
   `humanReview`) on **any** verdict change. It now resets only on a **withdrawal**
   (`previousVerdict === 'up' && nextVerdict !== 'up'`). A `null→up`, `null→down`,
   or `down→null/up` transition preserves the set-level approval. Rationale:
   verdict changes never mutate artifacts (only `recordThemeSetItemPhaseArtifacts`
   and the new `applyEditedThemeSetBrief` do), so the judge's score stays valid;
   only withdrawing an approval the set-level sign-off was predicated on should
   invalidate it. `canAdvanceThemeSet` independently blocks advance while any item
   is not `up`, so a preserved-but-stale set `up` can never green-light an invalid
   advance.

2. **"Approve remaining" bulk action.** `planApproveRemaining` (pure) +
   `approveRemainingThemeSetPhase` (mutation) up-vote every current-phase item that
   is **not** `down` **and** is eligible per `validatePhaseArtifactsForUpVote`,
   skipping ineligible items with a machine-readable reason
   (`item-rejected` / `item-missing-phase-artifact`). One `stateRevision` bump, one
   compare-and-swap write; an **empty batch writes nothing** (no revision churn).
   CLI action `approve-remaining`, canvas action `approve_remaining`.

3. **Hand-editable brief → "Save and Approve".** In the `briefs` phase the maintainer
   can edit the `selected-brief` YAML inline. When modified, the Approve button
   becomes **"Save and Approve"**: it runs `enableJudge` then `validateBriefYaml`
   (pure — schema + palette, **no disk write**) BEFORE writing; on success it writes
   the `enableJudge`'d YAML to a **new** revision key
   `selectedBriefKey(state, item, item.revision + 1)`, then `applyEditedThemeSetBrief`
   bumps `item.revision`, replaces the item's `briefs` artifacts/evidence, sets the
   item review to `up`, resets the set-level `briefs` review, and bumps
   `stateRevision`. Validation failure THROWS before any write, so a broken brief is
   never persisted and the live `r<old>` brief is never corrupted (a failed CAS at
   worst leaves a harmless orphan blob at the new key). **The edited brief bumps the
   item revision** (deliberate: the new brief is a new artifact and must be
   re-judged, exactly like a regenerated brief).
   CLI action `save-and-approve-brief`, canvas action `save_and_approve_brief`.
   Shared helpers (`selectedBriefKey`, `selectedBriefRevision`, `enableJudge`,
   `materializeAndLoadBrief`) were extracted from `theme-equipment-runner.ts` into a
   new `scripts/sprites/theme-equipment-brief.ts` so the CLI and runner share one
   source of truth.

4. **"Approve remaining" on every meaningful tab.** The renderer shows the bulk
   button on `roster`, `briefs`, `sprite-sheets`, `variant-approval` (never
   `complete`), with a truthful count-derived label
   (e.g. "Approve remaining 16 briefs"). The label is derived from
   `state.bulkApprove.count` (`planApproveRemaining`) — the **same predicate** the
   action uses, so the label can't diverge from what the button does.

5. **Honest judge-only Run label + guidance (closes the bulk-approve dead-end).**
   Bulk-approving every item leaves the phase in a state where every item is `up`
   but the phase's `collectionJudge` is still `null` — and `canAdvanceThemeSet`
   requires `collectionJudge.score >= 3`, so **Advance stays locked with no
   on-screen explanation** (the exact "I approved everything but there's no
   continue button" dead-end that motivated this whole work item). A `run-phase`
   dispatch fixes it because `runThemeEquipmentSetPhase` executes every
   _unresolved_ item and then judges the collection exactly once — so when nothing
   is unresolved a run **regenerates nothing and only produces the judge**. But the
   Run button used to read "Run / rerun unresolved items on GitHub", which lies in
   that state. New pure `planRunPhase(state)` returns
   `{ phase, regenerateCount, judgeOnly, collectionJudgeMissing }` derived from the
   **same** `isThemeSetItemResolvedForPhase` predicate the pipeline uses;
   `presentState` exposes it as `runPhase`. The renderer's `runPhaseLabel` composes
   the button text from that plan — "Regenerate N unresolved … + judge" when work
   remains, **"Judge collection cohesion on GitHub"** when `judgeOnly &&
collectionJudgeMissing`, "Re-judge collection cohesion on GitHub" when the judge
   already exists — and a conditional `.judge-hint` line renders only in the
   judge-missing state, telling the maintainer every item is approved but the
   collection judge is missing, Advance is locked until it lands, and clicking Run
   generates it (regenerating nothing). The label is derived from the same
   computation as the work it triggers, so it can never overstate the work.

6. **Phase advancement controls scoped to the active phase's own tab.** The Run /
   "Approve remaining" / Advance controls, the gate-blocker list, and the
   `.judge-hint` guidance previously rendered regardless of which phase tab was
   being viewed (they effectively lived on the roster page). The renderer now
   gates the entire phase-controls block on `selectedPhase === state.phase`, so a
   maintainer viewing a non-active tab sees the items for that phase but no
   advancement affordances — the controls always sit on the tab they act on.

## Bug caught by rule-#9 canvas verification (422 preview)

While verifying Save-and-Approve in the running canvas, the new `r1` brief preview
returned **422**. Root cause: `artifactStoreKey` ran its forward-slash key regex
against `artifact.uri`, which is `store.resolve(key)` — an absolute path with
**backslashes** on the local store on Windows — so the regex never matched. The
runner's own selected-brief previews had the same latent local-Windows bug. Fix:
normalize `artifact.uri.replace(/\\/g, '/')` before the regex. In production
(Azure) `resolve` returns a forward-slash URL, which is why it was never seen;
existing tests used a `memory://` store that also returns forward slashes.

## Verification (rule #9 — observed in the running canvas)

Seeded a **local scratch set** `scratch-review-ergonomics` (16 items: 5 weapon
types + 11 non-hand slots to pass the coverage gate; one `down` item, one briefless
item) rather than touching the maintainer's live Azure set (a `run-phase` would
have destroyed in-flight review). Verified end-to-end via the real CLI **and** in
the running canvas with Playwright:

- **(a)** Approving an item leaves the set-level Judge (4/5) and human approval
  intact — `verify-02-item-approved-collection-preserved.png`.
- **(b)** "Approve remaining 13 briefs" approved 13, **skipped 2** (naming the
  rejected item and the briefless item); the 1 already-`up` item was excluded
  from the count per `planApproveRemaining` semantics, single revision bump, set
  review preserved — `verify-03-approve-remaining-skips.png`.
- **(c)** Editing the textarea flipped the button to **"💾 Save and Approve"**
  (`verify-04-...png`); saving bumped `blade-of-embers` r0→r1 ("r1 frozen"),
  persisted the hand-edit with `judge.enabled: true`, and — after the 422 fix — the
  `r1` brief preview renders the hand-edited YAML with no 422
  (`verify-05-save-approve-persisted-r1.png`).
- Invalid-YAML failure contract: exit 1, no store write, no revision bump.
- **(d)** Change 5 (judge-only Run label): seeded a second local scratch set
  `scratch-judge-only` (all items `up`, `collectionJudge: null`, phase `roster`).
  In the running canvas the Run button read **"Judge collection cohesion on
  GitHub"** (not "Regenerate 0 …"), the conditional guidance line rendered
  ("Every item in this phase is approved, but the collection judge is missing —
  Advance stays locked until it lands. Click Judge collection cohesion on GitHub
  to generate it (it regenerates nothing)."), Advance was disabled, and the gate
  list showed only "Collection judge score is missing for phase 'roster'" —
  `change5-judge-only-run-label.png`.

Screenshots are in the session `files/visual-review/` dir (not committed).

## Tests

- `tests/unit/sprites/theme-equipment-set.test.ts` — narrowed invalidation,
  approve-remaining (skips, empty-batch no-write, set-preservation, single bump),
  save-and-approve brief mutation, **`planRunPhase` (5 tests: unresolved counts,
  judge-only, re-judge, non-review phase)**. (60 pass)
- `tests/unit/sprites/load-brief.test.ts` — `validateBriefYaml` (32 pass).
- `tests/unit/sprites/theme-equipment-review-cli.test.ts` — approve-remaining +
  save-and-approve CLI, and a **backslash-uri preview regression test** for the 422
  fix. (5 pass)
- `npm run verify:fast` green. Run sprites tests with
  `npx vitest run --project sprites <filter>` (they are **excluded** from the
  `unit` project).

## Review harness (3🍎)

- **plan_review** (gpt-5.4): 5 concerns (all in Change 3), all resolved — Change 3
  re-architected from in-place overwrite to a proper new-revision artifact mutation.
  `plan_divergence: major_fork`.
- **code_review** (round 1, claude-sonnet-4.6): clean, 1 trivial finding
  (duplicated `if (!setId)` 409 guard in `lib/server.mjs`) fixed.
  **code_review** (round 2, gpt-5.6-sol): clean — reviewed Change 5; confirmed
  `planRunPhase`'s `regenerateCount` matches the pipeline's unresolved-item set,
  no backticks introduced into the renderer template literal, label/guidance
  escaped and `state.runPhase` null-guarded, guidance predicate matches the label
  it references.
  **code_review** (round 3, gpt-5.6-terra): reviewed Change 6 (tab-scoped
  advancement controls) + the #2119 merge resolution. 1 Medium finding: a stale
  #2119 renderer test asserted the deleted client-side predicate
  (`work.withArtifacts ? 'Regenerate' : 'Generate'`) — retargeted to the surviving
  server-plan label `'Judge collection cohesion on GitHub'`. Otherwise clean.
- Ledger: `docs/knowledge/review-ledgers/2026-07-27-theme-equipment-review-ergonomics.review-ledger.json`
  (validates, exit 0).

## Files

- `scripts/sprites/theme-equipment-set.ts` — Changes 1, 2, 3 state logic +
  Change 5 `planRunPhase`.
- `scripts/sprites/theme-equipment-brief.ts` (new) — shared brief helpers.
- `scripts/sprites/theme-equipment-runner.ts` — extraction (behavior-preserving).
- `scripts/sprites/theme-equipment-review-cli.ts` — CLI actions + 422 fix +
  `runPhase` in `presentState`.
- `scripts/sprites/load-brief.ts` — `validateBriefYaml`.
- `.github/extensions/theme-equipment-review/{renderer,lib/bridge,lib/server}.mjs`,
  `extension.mjs` — canvas UI + actions.

## Gotchas for the next agent

- `renderer.mjs`'s entire client script is ONE template literal — a backtick
  anywhere (even a comment) is a syntax error. `node --check` it after every edit.
- Local-store uris on Windows use backslashes; `store.resolve(key)` is NOT a
  forward-slash URL there. Any code that regexes a store key out of a uri must
  normalize first (see `artifactStoreKey`).
- `saveThemeEquipmentSetState` does NOT bump `stateRevision`; the mutation helpers
  do. Don't double-bump.
- The scratch set and `_seed-scratch.ts` were deleted before PR; re-seed a fresh
  scratch set if you need to re-verify — never `run-phase` a real set mid-review.
- **NEVER open a canvas bound to a durable coordination set (e.g.
  `classic-fantasy-basic-leather`) from a branch that lacks PR #2119's cache fix.**
  On `main`, `CachingRunStore` treats `theme-sets/<id>/state.json` as an immutable
  read-through blob in a shared `cacache` dir outside any worktree, so the canvas
  serves a **stale revision** even after `extensions_reload` (Defect A). Worse, on
  `main` `CachingRunStore` implements neither `getWithETag` nor `putConditional`, so
  the CLI's compare-and-swap feature-test is false and every "CAS" silently degrades
  to an **unconditional overwrite** (Defect B) — a bulk "Approve remaining" computed
  from the stale snapshot will clobber newer Azure state with no conflict error, and
  the `expectedRevision` guard cannot catch it because it compares against the same
  stale revision it just read. This bit this session live: the panel rendered
  "Judge 5/5 · Approve remaining 18 briefs" while real Azure state was rev 83 with
  `collectionJudge=MISSING` and only 2 items up. Mitigation used: killed the
  theme-equipment-review extension PID so the panel port refused connections
  (there is no close-canvas tool, and a bound instance cannot be rebound to another
  setId). Only reopen a live-set panel after rebasing onto a `main` that carries
  #2119's cache fix, then re-read from Azure fresh before trusting the DOM.
  - **Diagnosis technique** (proven this session by the #2119 author): enumerate
    the shared cacache index at `~/.copilot/crawler/azure-resource-cache` for keys
    matching the mutable doc, e.g.
    `ns:<hash>:blob:theme-sets/<id>/state.json`,
    `ns:<hash>:list:theme-sets/<id>/`, and `ns:<hash>:list:theme-sets/`.
    A frozen-but-plausible snapshot that survives `extensions_reload` is the tell.
  - **Remediation**: removing those `blob:.../state.json` + `list:theme-sets/...`
    entries makes the next read hit Azure fresh. After clearing, the live set
    correctly rendered "Approve remaining 16 briefs" / "Regenerate 16 unresolved
    briefs + judge on GitHub" / "Judge pending" (matching rev 83: 2 up, judge
    missing) — confirming `computeBulkApprovePlan`/`planRunPhase` were always
    correct; the numbers were only ever wrong because the input state was stale.
  - **Process rule**: never report a canvas as "verified" from a read that could
    be cache-served. Assert the rendered DOM against a _fresh_ durable read
    (enumerate/clear the cache first, or read Azure directly). When a live
    artifact disagrees with your expectation, the artifact wins and the
    disagreement is itself the finding.

## Rebase resolution vs PR #2119 (`nalfeo-theme-set-index`) — READ BEFORE RESOLVING THE renderer.mjs CONFLICT

PR #2119 touches the **same Run-label region** of `renderer.mjs` and will conflict
with Change 5 on rebase. #2119 adds a pair of **client-side** helpers:

- `function runPhaseWork()` — a hand-maintained re-implementation of
  `isThemeSetItemResolvedForPhase` inside the renderer (its own handoff admits the
  first version counted the wrong items: "rejected items plus items with zero
  artifacts" instead of the runner's `isThemeSetItemResolvedForPhase`).
- `function runPhaseLabel()` (**zero-arg**) — calls `runPhaseWork()`, returns
  `'Dispatching…'` while `busy`.

Change 5 supersedes both with the **server-computed** plan: `planRunPhase(state)`
(in `theme-equipment-set.ts`, sharing the real predicate) → exposed as
`state.runPhase` → consumed by our `runPhaseLabel(plan, phase)`. A second copy of
the resolution rule in the renderer is exactly the drift hazard that made the Run
label lie in the first place.

**Correct resolution — do NOT keep both:**

1. **Delete** #2119's `runPhaseWork()` and its zero-arg `runPhaseLabel()` entirely.
   Keep our `runPhaseLabel(plan, phase)` (reads `state.runPhase`) and the
   `esc(runPhaseLabel(state.runPhase, state.phase))` button binding.
2. Keep the conditional `.judge-hint` guidance line and its `.judge-hint` CSS.
3. `grep` the renderer for any remaining call to the deleted zero-arg helpers —
   there must be none. Also confirm no other #2119 code references `runPhaseWork`.
4. Minor UX delta: #2119's label returned `'Dispatching…'` while `busy`; ours does
   not (the button already carries the `disabled` attr when `busy`, so it is
   functionally inert — no regression). Do not reintroduce a client-side predicate
   to restore that text; if the "Dispatching…" affordance is wanted, add a `busy`
   branch to our `runPhaseLabel(plan, phase)` — it must not recompute the plan.
5. Re-run `node --check .github/extensions/theme-equipment-review/renderer.mjs`,
   `npm run verify:fast`, and the live judge-only verification (scratch set) after
   the rebase, since the label path is what's being touched.

### PERFORMED EARLY (2026-07-27) — cache fix cherry-picked, not waiting for #2119

#2119 was stuck: the branch-protection ruleset requires a `merge-train` status
context that only the merge train posts (via a bypass actor), so `gh pr merge
--auto` can never satisfy it and the queue had an unknown ETA (tracked by issue
#2107 / epic #1850). Because the live panel is genuinely unsafe for the maintainer's
full Run flow without the cache fix (Defect B: a CI-side `state.json` write is not
observed by the local cache, and the next local write clobbers the just-landed
collection judge with no conflict error), the two store commits were cherry-picked
onto this branch instead of waiting:

- `6fdba7d73` → `a54b71af6` — stop caching mutable coordination docs + forward
  conditional writes (Defect A + store-layer half of B). Adds
  `scripts/sprites/store/cache-policy.ts`, `caching-store.ts` conditional-write
  forwarding, `+18` lines to `theme-equipment-set.ts`.
- `94000a869` → `2a3331dea` — gate the CAS path on `store.conditionalWrites ===
'atomic'` (hoisted above branch selection) + regression tests; `+44` lines to
  `theme-equipment-set.ts`.

The `renderer.mjs` conflicts (both commits) were resolved with `git checkout --ours`
— my whole renderer kept, ALL of #2119's renderer hunks dropped (client-side
`runPhaseWork()`, zero-arg `runPhaseLabel()`, and the `dispatchNotice` UI). Verified
no `runPhaseWork`/`dispatchNotice`/conflict markers survive; `node --check` passes.
`planRunPhase` (`theme-equipment-set.ts` ~1014) coexists cleanly with the new
atomic-CAS gate (~1449). `verify:fast` green; sprites suite 84 tests green.

**Live re-verification (rule #9, fresh Azure read):** after the reviewer purged the
four stale `cacache` entries AND with the cache-policy fix now on-branch, the panel
on `classic-fantasy-basic-leather` renders "Approve remaining **16** briefs",
"Regenerate 16 unresolved briefs + judge on GitHub", "Judge pending", Advance
disabled — matching Azure rev 83 (16 approvable, judge missing, 2 up). Evidence:
`files/visual-review/change6-cachefix-live-16briefs-judge-pending.png`. This also
re-confirms Change 5's label logic against fresh state (16, judge-missing → judge
regenerates nothing once all resolved).

**When #2119 eventually merges:** git will see these store changes as already-applied
(same commit content), so the merge/rebase is a no-op for them — no re-resolution
needed. Only re-check that no NEW #2119 renderer code references the deleted helpers.

### FOLLOW-UP (2026-07-28) — #2119 merged to `main`; `origin/main` merged into this branch

PR #2119 (`nalfeo-theme-set-index`) merged to `main` (`f34efc79a`). `origin/main` was
merged into this branch (commit `6931571e7`) rather than rebased — PR #2138
squash-merges, so branch history is irrelevant to the final tree and a single merge
commit is far safer than replaying 16 commits. Auto-merge results:

- **`theme-equipment-set.ts` + `scripts/sprites/store/**` auto-merged cleanly.** Both
feature sets survived: my four functions (`planApproveRemaining`,
`approveRemainingThemeSetPhase`, `applyEditedThemeSetBrief`, `planRunPhase`) AND
#2119's store-layer CAS (revision-conflict + `conditionalWrites === 'atomic'` gate)
  are both present. Because the earlier cherry-pick already carried #2119's store
  content, git saw it as already-applied — no store re-resolution.
- **`renderer.mjs` conflict resolved exactly as documented above:** kept my whole
  renderer (server-plan-driven `runPhaseLabel(plan, phase)`), deleted #2119's
  client-side `runPhaseWork()` / zero-arg `runPhaseLabel()` / `PHASE_NOUNS`, preserved
  #2119's separate `dispatchNotice` banner. `bridge.mjs`: unioned #2119's
  `cliEntryResolvers` with my `SERIALIZED_ACTIONS`. `theme-equipment-set.test.ts`
  add/add and the review-ledger add/add resolved by keeping both sides.
- **Stale #2119 renderer test retargeted** (`renderer.test.mjs` line 16): it asserted
  the deleted client-side predicate; now asserts the surviving server-plan label
  `'Judge collection cohesion on GitHub'`. Committed `e04ec2133`.
- `node --check renderer.mjs` OK; extension tests pass (renderer 10, bridge 8,
  server 16, cli-bundle 10 — run each file individually via `node --test <path>`, a
  dir-level run gives a spurious `MODULE_NOT_FOUND`); sprites vitest
  `--project sprites theme-equipment` 117 pass; `verify:fast` green.

**Post-merge live re-verification (rule #9, fresh Azure reads — NOT cache):** with the
cache-policy fix now on-branch via the merge, panels read fresh durable state, closing
the stale-snapshot hazard on this branch.

- **Live set `classic-fantasy-basic-leather`** — fresh CLI read: azure-blob **rev 85**,
  phase `briefs`, all 18 items `up`, `collectionJudge` PRESENT (score 4),
  `humanReview` up, `bulkApprove.count=0`, `runPhase.regenerateCount=0`. The maintainer
  has since used the new tools; the set is now Advance-ready. Playwright DOM at the
  live panel matched exactly: Run "Re-judge collection cohesion on GitHub",
  Approve-remaining absent (count 0), **Advance enabled**, gate blockers `[]`, 18 up —
  the exact success state this work targeted (rev 85 > reviewer's earlier stale rev 83
  → cache fix confirmed active). Evidence:
  `files/visual-review/postmerge-live-rev85-advance-unlocked.png`.
- **Change 5 judge-missing case, re-verified against a fresh durable read** (reviewer
  requirement #3): seeded a scratch set `scratch-judge-missing` (azure-blob rev 1: 18
  items `up`, `collectionJudge: null`, `humanReview` verdict null, phase `briefs`).
  Fresh CLI read confirmed judge MISSING / all resolved. Playwright DOM: Run label
  **"Judge collection cohesion on GitHub"** (not "Regenerate 0 …"), the conditional
  `.judge-hint` guidance line present, Approve-remaining absent (count 0), Advance
  **blocked** with gate blocker "Collection judge score is missing for phase
  'briefs'". Asserted against the fresh rev-1 read, not cache. Evidence:
  `files/visual-review/postmerge-scratch-judge-missing-label.png`. Scratch set + temp
  seed/delete scripts removed after verification.
