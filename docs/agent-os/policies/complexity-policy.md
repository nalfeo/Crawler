# Complexity Policy — Apple Scale

## Purpose

Give agents a shared, honest vocabulary for estimating task size. The goal is **calibration over time**, not speed pressure. A task rated 🍎🍎🍎 should feel like a 🍎🍎🍎 after you finish it.

---

## The Scale

| Apples     | Label   | What it means                                                                             |
| ---------- | ------- | ----------------------------------------------------------------------------------------- |
| 🍎         | Trivial | Single file. Doc edits, renames, config tweaks, one-liner fixes. No new types or systems. |
| 🍎🍎       | Small   | 1–3 files. New function or type, simple bug fix, a test suite. No lab required.           |
| 🍎🍎🍎     | Medium  | New module or sub-system. 3–10 files. Tests required. May need a lab. Usually no ADR.     |
| 🍎🍎🍎🍎   | Large   | New ECS system + lab + tests + ADR. Multi-system coordination or architectural impact.    |
| 🍎🍎🍎🍎🍎 | Massive | Full feature spanning multiple systems, new pipeline, ADR required. Equals 1 hello kitty. |

**5 apples = 1 hello kitty 🎀**

A hello kitty is the planning unit for a session. A session that ships 1 hello kitty has delivered meaningful, coherent work. Two hello kitties is an excellent session. Track them in the handoff file.

### Tooling-only ceremony cap

Work confined to developer/agent tooling, canvases, automation, or asset-pipeline
tooling is estimated at **no more than 3🍎**, regardless of file count. This is a
ceremony cap, not permission to skip tests or split an incoherent change: a
3🍎 tooling change still receives the separate-model plan review and code-review
loop required by the review harness. The cap does not apply when the change
alters runtime gameplay behavior or shipped game data.

---

## Codebase Examples

| Task                                                              | Apples     |
| ----------------------------------------------------------------- | ---------- |
| Fix a typo in a policy doc                                        | 🍎         |
| Add a constant to `src/shared/`                                   | 🍎         |
| Fix a lint warning or config knob                                 | 🍎         |
| Add a new test file for an existing system                        | 🍎🍎       |
| Add a helper function to `src/shared/`                            | 🍎🍎       |
| Fix a bug in an existing ECS system                               | 🍎🍎       |
| Add a new automation health script                                | 🍎🍎🍎     |
| Add a new ECS component + query                                   | 🍎🍎🍎     |
| Implement a new game sub-system (e.g. drops) with tests           | 🍎🍎🍎     |
| New ECS system from scratch (e.g. `movementSystem`) + lab + tests | 🍎🍎🍎🍎   |
| New multi-system pipeline with ADR                                | 🍎🍎🍎🍎   |
| Full new game feature (e.g. crafting system)                      | 🍎🍎🍎🍎🍎 |

---

## When to Declare

**Before writing implementation code in a merge-intent session.** State the estimate in your first session turn as:

> "Estimating this at 🍎🍎🍎 (Medium) — new sub-system, 3–5 files, tests required."

For **1–2🍎 sessions** that is the entire **file-writing** ritual — no apples JSON is needed. You still score actual + verdict in the handoff `## Apples` line; only the per-session JSON file is waived. The review harness doesn't fire at these tiers so a calibration file provides no actionable signal.

For **≥3🍎 sessions**, also run `npm run apples:record` at handoff (see below).

---

## Review Harness Trigger

The apple estimate you declare also selects how much **pre-PR review** the change
must receive. For 1–2🍎 changes, no ledger is required. For ≥3🍎 changes, commit
and validate a **review ledger** for the tier; a present-but-invalid ledger is a
hard blocker, while a missing ledger is treated as an artifact gap that the
authoring or recovery agent must fix rather than escalate by default.

| Apples | Required review stages (recorded in the ledger)                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1🍎    | (none — the ledger records the tier only)                                                                                         |
| 2🍎    | (none — the ledger records the tier only)                                                                                         |
| 3🍎    | separate-model **plan review** before coding + **code review** (loop until clean)                                                 |
| 4–5🍎  | plan review must be **adversarial** (≥2 alternatives, argue against the design) + **code review** (loop) + **multi-model review** |

`dual-plan synthesis` was **retired as a required 4–5🍎 stage on 2026-07-08 (ADR 0051)** — reading all past ledgers showed two independent plan authors produced a
decisive design fork on only 2/17 (12%) of firings, so the 4–5🍎 `plan_review` is
now **adversarial** (one critic enumerates ≥2 alternatives and argues against the
chosen design) instead, at ⅓ the cost. Every plan review at ≥3🍎 also records a
`plan_divergence` signal so we can measure the real fork rate going forward.

The plan-review floor was raised **2🍎 → 3🍎 on 2026-07-07** to match the
code-review floor (moved to 3🍎 on 2026-07-02, ADR 0036). Both the `code_review`
and `multi_model_review` loops are **bounded**: after **2 genuinely-attempted
rounds** an intractable stage may terminate by recording an `escalated_to_human`
state instead of looping forever (never on round 1, never a silent skip). See
[`review-harness-policy.md`](review-harness-policy.md).

Run the harness with the [`review-harness` skill](../../../.github/skills/review-harness/SKILL.md);
the full rules, ledger format, and bypass live in
[`review-harness-policy.md`](review-harness-policy.md).

---

## Re-scoring After Planning (downward only)

Your declared estimate can be wrong once the diff exists. You may **re-score**,
but only **strictly downward** and only when the **actual diff** justifies it —
e.g. a 4🍎 plan that collapsed into a one-file tweak is genuinely a 2🍎 change.
Record it in the review ledger with `apples_rescored_from` (the original higher
estimate) + `rescore_reason`; the validator rejects upward or no-op re-scores. A
downward re-score lowers the required review stages to the new tier, so prune any
now-unrequired incomplete stages from the ledger. This is distinct from
**calibration scoring** below (which records estimated-vs-actual for the apple
log, and may go either direction). Never re-score down merely to dodge a review
stage (project rule #12).

---

## Calibration Scoring (at Handoff)

At the end of every **implementation session** (merge-intent code change), score the **actual** apples and compute the verdict:

| delta = actual − estimated | Verdict  | Meaning                        |
| -------------------------- | -------- | ------------------------------ |
| 0                          | 🎯 Exact | Perfect call                   |
| +1                         | 📉 Under | Task was harder than expected  |
| −1                         | 📈 Over  | Task was easier than expected  |
| ±2 or more                 | 💥 Miss  | Estimation needs recalibration |

Write one sentence explaining the gap. Over time the apple log surfaces whether you systematically over- or under-estimate a particular apple level.

---

## Anti-patterns

- **The vague 4-apple dump.** Calling everything 4 apples because you're unsure. If it's uncertain, say why: "Estimating 🍎🍎🍎🍎 because I haven't mapped the dependency graph yet."
- **Inflation.** Marking a doc edit as 🍎🍎🍎 to make the session look bigger.
- **Deflation.** Marking a new ECS system as 🍎 to seem efficient.
- **Skipping the estimate.** The system only works if you declare before starting.
- **5-apple avoidance.** Refusing to call a task 🍎🍎🍎🍎🍎 and instead calling it "4 apples with scope creep". If it genuinely spans multiple systems with an ADR, call it 5.

---

## Splitting Large Tasks

If a task feels like 6+ apples, split it. A single session should not attempt more than 5 apples in one shot without an explicit scope note. Prefer:

1. Identify the minimum deliverable that compiles and passes tests.
2. Rate that slice.
3. Scope the remainder as a follow-up session.

---

## Recording Apple Entries (≥3🍎 sessions only)

At the end of every **≥3🍎** session run:

```
npm run apples:record -- --session <slug> --estimated <n> --actual <n>
```

where `<slug>` matches the handoff filename slug (e.g. `movement-system` for `2026-06-21-movement-system.md`).

The script auto-computes `delta`, `verdict`, and `hello_kitties`, uses today's date, and writes:

```
docs/knowledge/metrics/apples/YYYY-MM-DD-<slug>.json
```

**Do not hand-write these files** — use the script to avoid wrong values and unnecessary fix turns.

**1–2🍎 sessions do not need a file.** The review harness never fires at these tiers, so recording provides no actionable signal.

`hello_kitties` = `actual_apples / 5` (rounded to 2 decimal places). **5 apples = 1 hello kitty 🎀**

**Why individual files?** Each session writes its own file so concurrent PRs never conflict. The legacy `docs/knowledge/metrics/apple-log.json` is kept as historical data and is still read by the calibration script.
