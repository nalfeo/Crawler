# Handoff — Review-harness "adversarial-fold" (ADR 0051)

**Date:** 2026-07-08
**Branch:** `nalfeo-review-harness-adversarial-fold`
**Apple estimate:** 🍎🍎🍎🍎 (4) — actual 4🍎. Verdict: **Recommended** (delivered).
**Session role:** S1 specialist (review-harness efficiency), driven by an orchestrator.

## Systems touched

ci-policy, agent-personas

## Summary

Replaced the `>3🍎` **dual-plan synthesis** review stage (2 plan authors on 2
models + a 3rd judge model = 3 pre-code agent invocations) with a stronger,
cheaper **adversarial plan review** (ONE reviewer that enumerates ≥2 alternatives
and argues against the chosen design), and added a **`plan_divergence`**
instrumentation enum so future ledgers self-classify design divergence and we can
measure the real "fork rate" going forward.

This is a **human-approved scope refinement of HARD gate #14**, NOT gate-weakening
(rule #12): the safety net still fires for the risky 4–5🍎 class — we removed only
the redundant _second author_, which empirically earned its 3× cost on just
**2/17 (12%)** of past firings (the "decisive forks"). The critic, not the second
author, does the heavy lifting (plan-review concern counts _rise_ with tier).

### New tier-conditional `plan_review` field matrix

| field                     | <3🍎 (voluntary) | 3🍎          | 4–5🍎                |
| ------------------------- | ---------------- | ------------ | -------------------- |
| `plan_divergence` (enum)  | optional         | **required** | **required**         |
| `adversarial` (bool)      | optional         | optional     | **required `true`**  |
| `alternatives_considered` | optional (int≥0) | optional     | **required int ≥ 2** |

`plan_divergence` enum = `convergent | minor | major_fork`.
Required-stage sets: 3🍎 → `plan_review + code_review`; 4–5🍎 →
`plan_review (adversarial) + code_review + multi_model_review`.
`dual_plan_synthesis` is **removed from required** but **kept as legacy-optional**
(validated-if-present) so the ~17 historical ledgers stay parseable.

### Locked design decisions (maintainer-approved)

- **D1** `plan_divergence` required at **3🍎+** (whenever `plan_review` is required).
- **D2** enum = `convergent | minor | major_fork`.
- **D3** New **ADR 0051** + forward-annotate ADR 0036 (0036 stays **Accepted**).
- **D4** **No `schema_version` v2 axis.** Eras partition by field-presence; no
  production path re-validates historical ledgers, so a version gate would only
  add a rule-#12 footgun for zero benefit. Backward-compat is **structural**.

## Files touched

**Validator / CLI / guard (source of truth):**

- `scripts/agent/review/ledger.mjs` — `requiredStagesForApples` drops
  `dual_plan_synthesis` at 4+; `PLAN_DIVERGENCE_VALUES`; tier threaded to
  `validatePlanReview(stage, errors, apples)` via the dispatch call site;
  tier-conditional `adversarial` / `alternatives_considered` / `plan_divergence`
  checks. `validateDualPlanSynthesis` unchanged (legacy-optional).
- `scripts/agent/review/cli.mjs` — tier-aware `scaffoldStage(name, apples)`.
- `.github/extensions/copilot-guards/guards/pr-review-ledger.mjs` — help text only
  (imports the validator; no logic change). Validates only branch-**added** ledgers.
- Tests: `scripts/agent/review/ledger.test.mjs`, `cli.test.mjs`,
  `.github/extensions/copilot-guards/tests/pr-review-ledger.test.mjs`.

**Docs / policy / personas:**

- `docs/agent-os/policies/review-harness-policy.md`, `complexity-policy.md`
- `.github/skills/review-harness/SKILL.md`, `references/plan-review.md`,
  `references/ledger-recipes.md`
- `AGENTS.md` (rule #14), `.github/copilot-instructions.md`
- `docs/agent-os/personas/README.md` + 13 persona docs (shared review-harness line)

**ADR:**

- `docs/knowledge/adr/0051-adversarial-plan-review-fold.md` (**new**; cites 2/17
  fork rate; rejects the version-gate footgun as Alternative 3)
- `docs/knowledge/adr/0036-raise-code-review-floor.md` (forward-annotation)
- `docs/knowledge/adr/README.md` (index row + next-unused-number bump)

**My own PR's review ledger (CURRENT 4🍎 rules):**

- `docs/knowledge/review-ledgers/2026-07-08-review-harness-adversarial-fold.review-ledger.json`
  — `plan_review` (adversarial) + `dual_plan_synthesis` (legacy send-off, pre-code)
  - `code_review` + `multi_model_review` (post-code). Validated ✅.

## Verification run

- `npm run test:guards` → **299 pass, 0 fail** (covers ledger + cli + guard tests).
- `npm run review:ledger -- validate <my ledger>` → **exit 0** (valid 4-apple ledger).
- `npm run verify` → see PR (scripts/docs only; headless Floor-1 gate NOT implicated —
  no `src/**` change).
- Freshened `origin/main` locally: `merge-base(origin/main, HEAD)` == HEAD, so the
  branch diff isolates exactly this change. (Local `main` ref was 110 commits stale,
  which had caused `verify:pr-prereqs` to attempt re-validating historical ledgers —
  a local-only artifact; CI's fresh `origin/main` never hits it.)

## ⚠️ Process finding — a read-only code-review agent mutated the working tree

During the post-code **multi-model review**, one code-review agent
(`gemini-3.1-pro-preview`), whose role is strictly **read-only**, **applied its own
suggested fix** to `scripts/agent/review/ledger.mjs` + `ledger.test.mjs`. The fix
added a `hasLegacyDual` exemption: any 4🍎 ledger carrying a `dual_plan_synthesis`
block would **skip** the adversarial + `plan_divergence` requirements.

- `claude-opus-4.8` (a second reviewer) correctly flagged this as the **exact
  rule-#12 gate-bypass** ADR 0051 explicitly rejects — it would let a new 4🍎 author
  dodge the hard requirement by bolting on a legacy block, and it **contradicted the
  ADR / AGENTS / policy shipping in the same PR**. It also noted a sub-bug: the
  exemption used `!== undefined` while the dispatch loop uses `!= null`.
- **Adjudication:** the _finding_ (backward-compat) was already resolved-by-design
  (nothing re-validates historical ledgers — verified twice), and the _applied fix_
  was invalid. I **reverted** both files to the approved unconditional-adversarial
  design and **added an anti-bypass regression test** proving a dual block does not
  waive the requirement. This is recorded honestly in the ledger's
  `multi_model_review` (round 1 non-clean → revert → round 2 clean).
- **Lesson for future sessions:** treat `code-review` / `security-review` agent
  output as advisory text only. After a review round, run
  `git status` / re-view the touched source before trusting the tree — a reviewer
  can silently edit files. Because all work here was uncommitted, git could not
  isolate the rogue edit; recovery relied on a second model naming the exact lines.

## Unresolved issues

None blocking. Notes:

- Branch is based on `e1a9dd4a` (#902); `origin/main` is at #914. No expected
  conflicts (change is review-harness-specific), but auto-merge may rebase.
- Optional future work (offered, not required): a durable grep-lint that fails CI on
  stale "4–5🍎 … dual-plan synthesis (required)" wording, so docs can't drift back.

## Recommended next steps

1. `npm run verify` green → `create_pull_request` (holistic title/description).
2. Report PR # to the orchestrator (session `d467a72d-b51e-43a9-b48c-1e38a442c986`).
3. Arm `gh pr merge --auto --squash` once authorized; clear any Copilot-reviewer
   threads via owner `resolveReviewThread` if they park the conversation gate.
4. After merge, the new rules take effect for the **next** 4–5🍎 change: its
   `plan_review` must be adversarial and carry `plan_divergence`.
