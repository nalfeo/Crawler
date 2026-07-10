# ADR 0056: GitHub-First Broad-Sweep Execution and Investigation Session Process Boundary

## Status

Accepted

## Date

2026-07-10

## Estimated Complexity

🍎 x 4 — multi-system process/policy/tooling coordination with a new workflow path + ADR

## Context

Two process gaps were causing repeated friction:

1. **Broad sweeps run locally.** Weapon sweeps and other batch evaluations (>10 runs)
   were being executed inside agent sessions, consuming session resources, blocking the
   session window for minutes to hours, and producing results that were hard to reproduce
   or share. No dedicated GitHub-backed execution path existed.

2. **Investigation sessions accrued full PR paperwork.** Debug and repro sessions that
   did not land code were expected to write handoffs, review ledgers, and apple estimates
   even when nothing was being merged. This created overhead that discouraged lightweight
   investigation and made the investigation-vs-implementation boundary blurry.

The Quick Start in `AGENTS.md` (step 7) also stated "write a handoff before ending your
session" unconditionally, conflicting with the new investigation exemption.

## Decision

1. **Broad sweeps (>10 runs) default to GitHub Actions** (`workflow_dispatch`/CI runners)
   rather than local/session compute. Local execution is permitted only for smoke runs
   (≤10 runs) or explicit human override. A concrete dispatch workflow
   (`.github/workflows/weapon-sweep.yml`) is provided for Floor-1 weapon balance sweeps;
   it shards execution by weapon via a matrix strategy so weapons run in parallel and
   within the per-job timeout budget.

2. **Investigation sessions are process-light.** Repro/debug sessions that do not produce
   merge-intent code changes may skip review ledger, handoff, and apple paperwork. When
   an investigation identifies a fix to ship, the fix opens a **separate implementation
   session/PR** that runs the full normal process.

3. **AGENTS.md Quick Start step 7 is scoped** to implementation sessions:
   "Write a handoff file before ending implementation sessions (merge-intent changes);
   investigation sessions without merge-intent fixes may skip this."

These rules are mirrored across `AGENTS.md`, `.github/copilot-instructions.md`,
`docs/agent-os/policies/ci-policy.md`, and `docs/agent-os/policies/review-harness-policy.md`,
and enforcement is added to `scripts/agent/docs/check-session-instructions.ts`.

## Consequences

### Positive

- Broad sweeps no longer block session windows; parallel weapon-matrix jobs reduce
  wall-clock time per sweep.
- Investigation sessions carry appropriate overhead — none when nothing is landing.
- The handoff/process requirement is now consistently scoped everywhere it appears.
- The concrete `weapon-sweep.yml` workflow gives agents and humans a single runnable path.

### Negative

- Agents must remember to use `gh workflow run weapon-sweep.yml` rather than running
  `npm run ai:weapon-sweep` locally for any sweep >10 runs.
- Splitting investigation from implementation requires discipline to not blur the boundary.

### Risks

- If agents misclassify an investigation as "process-light" when it is actually landing
  code, they may skip required review. Mitigation: the guard on `create_pull_request`
  enforces the review ledger for code changes regardless of session framing.

## Alternatives Considered

- **Keep local sweeps, just cap them.** Rejected — capping doesn't solve the session
  resource problem and still forces agents to wait.
- **Require full paperwork for all sessions.** Rejected — it adds overhead with no benefit
  for sessions that produce no code artifacts.
- **Change the "parallelized" wording without adding sharding.** Rejected — fixing the
  workflow to actually parallelize is more valuable than changing the description.
