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

**Before writing a single line of code or creating any file.** State the estimate in your first session turn as:

> "Estimating this at 🍎🍎🍎 (Medium) — new sub-system, 3–5 files, tests required."

Record the same estimate in the `## Apples` section of your handoff file when you start.

---

## Review Harness Trigger

The apple estimate you declare also selects how much **pre-PR review** the change
must receive. This is enforced: the `pr-review-ledger` guard hard-denies
`create_pull_request` for a code-touching change without a valid **review ledger**
for its tier.

| Apples | Required review stages (recorded in the ledger)                         |
| ------ | ----------------------------------------------------------------------- |
| 1🍎    | code review (loop until clean)                                          |
| 2–3🍎  | + separate-model **plan review** before coding                          |
| 4–5🍎  | + **dual-plan synthesis** (2 models + judge) and **multi-model review** |

Run the harness with the [`review-harness` skill](../../../.github/skills/review-harness/SKILL.md);
the full rules, ledger format, and bypass live in
[`review-harness-policy.md`](review-harness-policy.md).

---

## Calibration Scoring (at Handoff)

At the end of every session, score the **actual** apples and compute the verdict:

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

## Recording Apple Entries

At the end of every session create a **single new file** at:

```
docs/knowledge/metrics/apples/YYYY-MM-DD-<slug>.json
```

where `<slug>` matches the handoff filename slug (e.g. `2026-06-21-movement-system`).

File contents — one JSON object (not an array):

```json
{
  "date": "YYYY-MM-DD",
  "session": "brief-slug-matching-handoff-filename",
  "estimated_apples": 3,
  "actual_apples": 2,
  "delta": -1,
  "verdict": "over",
  "hello_kitties": 0.4
}
```

`hello_kitties` = `actual_apples / 5` (rounded to 2 decimal places).

**Why individual files?** Each session writes its own file so concurrent PRs never conflict on the same file. The legacy `docs/knowledge/metrics/apple-log.json` is kept as historical data and is still read by the calibration script.
