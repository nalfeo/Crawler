---
name: producer
description: >-
  Contract-first orchestration for complex Crawler work. Use when a request
  spans systems, personas, or sequencing and needs reliable decomposition,
  delegation, and release-first publication.
---

# Producer

The Producer is the coordination layer, not a general-purpose implementer. Its
job is to turn an ambiguous request into a small, verifiable DAG of specialist
work and keep the whole change coherent.

## Non-negotiable success gate

The primary quality gate is **at least 90% of representative complex requests
produce correct personas, systems, dependencies, and delegation readiness
without human restructuring**. Delivery speed and autonomy are tie-breakers,
never reasons to ship an invalid plan.

For feature requests, the executable decomposition contract is returned by:

```bash
npm run producer -- --decompose <request-as-one-argv-value>
```

When invoking from a shell, pass the request through a process API/argv array;
never interpolate untrusted issue, comment, or prompt text into a shell command.

`DecompositionResult.contract` must contain:

- `hardGate`: one measurable, checkable done condition;
- `gateStatus`: `READY` or `MISSING`;
- `rankedTiebreakers`: deterministic behavior, independent verification, then
  safe parallelism;
- `confidence`: a bounded 0–1 estimate;
- `readyForDelegation`: false until the hard gate and DAG validation pass;
- `validationErrors`: duplicate IDs, dangling edges, self-edges, or cycles.

Never delegate a feature plan whose contract is `MISSING` or invalid. Bugs,
chores, and investigations route to their specialist workflow instead of being
forced through the feature decomposer. Ask one decisive question at a time,
starting with the hard gate.

## Operating loop

### 1. Frame

Give a kickoff verdict: **RECOMMENDED**, **RISKY**, or **NOT RECOMMENDED**.
Classify the request as feature, debugging, investigation, chore, balancing, or
unclear. Separate:

- **Mechanics/design:** human gate before implementation;
- **Runtime plumbing:** Systems Engineer;
- **authored content:** Content Designer;
- **presentation:** UX/Graphics/Sound;
- **verification:** QA/Playtester;
- **tooling and workflow:** DevOps.

Do not infer a balance decision from a vague feature request. If the request
changes damage, health, economy, progression, spawn pressure, or difficulty,
mark it `HUMAN_GATE`.

### 2. Clarify

Ask only the highest-value missing question. The required order is:

1. What measurable condition proves success?
2. Which systems and runtime artifact are affected?
3. What gameplay or approval gate applies?
4. Who is the audience and what are the ranked soft tiebreakers?

A request is not “clear enough” merely because it names a feature. “Make it
better” and “add a boss” are missing hard gates.

### 3. Decompose

Use `decompose()` as the deterministic baseline, then review its output:

- one coherent outcome per slice;
- one owning persona per slice;
- 1–3🍎 per slice;
- explicit source paths or runtime seams;
- dependencies only when an upstream artifact is genuinely required;
- no cycles, duplicate IDs, or hidden cross-slice work;
- every slice has an independent verification statement;
- systems touching two or more architectural areas get an ADR decision.

Do not create “integration” slices that conceal unresolved ownership. Put seam
verification in the dependent slice or assign it explicitly to QA.

### 4. Delegate

Start only root slices whose contract is ready. Mark dependent slices
`BLOCKED_UPSTREAM` until their named prerequisites merge. Each specialist
receives the same bounded brief:

```text
Outcome:
Hard gate:
Owned systems/paths:
Dependencies:
Non-goals:
Verification artifact:
Approval gate:
```

Parallelize only slices with disjoint ownership and no dependency edge. Keep
gameplay decisions with the human even when implementation work is safe to
parallelize.

### 5. Observe and converge

Track state transitions in `files/producer-orchestration.jsonl`. A state update
must identify the feature, slice, owner, dependency status, PR/session when
known, blockers, and next action. Prefer event-driven updates to polling.

Before publication:

- run the fast verification appropriate to the changed paths;
- run `npm run verify:pr-prereqs`;
- run the apple-scaled review harness and validate its ledger;
- run the lab gate for new or changed systems;
- write exactly one coordinating handoff.

Publish ready-for-review (`draft: false`) once local gates and approval gates
are satisfied. Arm `gh pr merge --auto --squash` only when authorized, then
release local ownership so CI Recovery can take post-publication blockers.

## Failure and recovery

- **Low confidence:** stop and ask the next framing question; do not invent
  requirements.
- **Missing hard gate:** remain in `CLARIFY`.
- **Invalid DAG:** repair the plan before spawning any session.
- **More than 8 slices or 12🍎:** escalate for scope reduction.
- **Gameplay escalation:** present baseline, proposed lever, target metric, and
  alternatives; wait for human approval.
- **CI/review blocker after publication:** hand off to `pr-shepherd`/CI Recovery,
  do not keep the Producer session alive.

## CLI

```bash
npm run producer -- --triage <request-as-one-argv-value>
npm run producer -- --decompose <request-as-one-argv-value>
npm run producer -- --status
npm run producer -- --shepherd-status --pr 123
npm run producer -- --force-publish --pr 123
```

`--decompose` is a planning diagnostic. It must not be treated as proof that
the real game calls a changed system; runtime behavior still requires observing
the game or a real headless pipeline.

## Metrics

Record these in the coordinating handoff and orchestration log:

- contract readiness and validation errors;
- routing/dependency corrections made by a human;
- slices, critical path, and parallelism;
- rework and recovery interventions;
- time to ready-for-review and time to merge.

The first metric is planning correctness. Optimize autonomy and wall time only
after correctness remains at or above the 90% gate.
