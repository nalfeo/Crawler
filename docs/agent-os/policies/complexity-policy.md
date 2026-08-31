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
3🍎 tooling change still receives the independent post-diff code review required
by the review policy. The cap does not apply when the change
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

For **1–2🍎 sessions** that is the entire **file-writing** ritual — no apples JSON is needed. You still score actual + verdict in the handoff `## Apples` line; only the per-session JSON file is waived.

For **≥3🍎 sessions**, also run `npm run apples:record` at handoff (see below).

---

## Review Trigger

The apple estimate selects how much independent **post-diff review** the change
must receive. Reviews are recorded only in GitHub PR reviews and threads; no
repository review artifact is created.

| Apples | Required review                         |
| ------ | --------------------------------------- |
| 1–2🍎  | Tests and CI only.                      |
| 3🍎    | One independent post-diff code review.  |
| 4–5🍎  | Two independent post-diff code reviews. |

Adversarial design review is required only when the change is architectural; a
large but non-architectural change does not trigger it. See
[`review-harness-policy.md`](review-harness-policy.md).

Run the process with the [`review-harness` skill](../../../.github/skills/review-harness/SKILL.md);
the full rules live in
[`review-harness-policy.md`](review-harness-policy.md).

---

## Re-scoring After Planning

Your declared estimate can be wrong once the diff exists. Record the actual
score at handoff, but use the declared estimate to select the required review
tier. Never re-score merely to dodge a review.

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

**1–2🍎 sessions do not need a file.**

`hello_kitties` = `actual_apples / 5` (rounded to 2 decimal places). **5 apples = 1 hello kitty 🎀**

**Why individual files?** Each session writes its own file so concurrent PRs never conflict. The legacy `docs/knowledge/metrics/apple-log.json` is kept as historical data and is still read by the calibration script.
