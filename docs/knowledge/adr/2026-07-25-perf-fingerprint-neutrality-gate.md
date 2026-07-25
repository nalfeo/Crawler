# ADR: Perf fingerprint neutrality gate contract

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 3 — cross-system tooling + CI policy contract, no gameplay runtime changes

## Context

The perf-optimizer workflow needs a deterministic gate that detects gameplay drift
while allowing legitimate resource wins. The gate compares headless Floor-1 runs by
hashing canonicalized end-of-run `RunStats`.

This work spans MCP/tooling guidance and CI policy. Without a recorded contract, three
areas drifted in review:

1. whether the 24-run workload may bypass the repository-wide `>10 runs => GitHub-backed`
   execution default;
2. baseline lifecycle rules (how/when to regenerate, what invalidates a baseline);
3. coverage expectations (what a clean fingerprint does and does not prove).

## Decision

1. **Execution policy:** treat the 24-run fingerprint workload as a `>10` run workload.
   It defaults to GitHub-backed execution. Local execution is allowed only when a human
   explicitly requests local.
2. **Baseline lifecycle:** a baseline is valid only for the same fingerprint schema and
   same recorded sample (seeds/weapons/maxFrames). Version or sample mismatch is a hard
   failure; do not reinterpret it as gameplay drift.
3. **Coverage statement:** a clean check proves byte-identical covered end-of-run
   `RunStats` only. It is a strong neutrality signal for sampled headless runs, but not
   a full world-state proof and not evidence for render/load/input/browser paths.
4. **Canonicalization authority:** the fingerprint gate reuses `src/shared/canonical-json.ts`
   for canonical serialization and hashing. The fingerprint layer keeps a small pre-pass
   that normalizes `RunStats`-specific JSON semantics before serialization.

## Consequences

### Positive

- Tooling docs, agent prompts, and review expectations now share one explicit policy.
- Fingerprint comparisons fail loudly on stale or non-comparable baselines.
- Canonical serialization hardening in `src/shared/canonical-json.ts` is inherited by
  the fingerprint gate.

### Negative

- Full-gate fingerprint checks now default off local machines, so local-only iteration
  may be slower unless explicitly requested by a human.
- The fingerprint still requires additional surface-specific observation for render/load
  work.

### Risks

- If GitHub-backed execution paths are unavailable, perf work can stall until infra is
  restored or a human authorizes local execution.
- Future `RunStats` schema changes can invalidate existing baselines and require planned
  regeneration.

## Alternatives Considered

1. **Keep a local-only exception for the 24-run sample.** Rejected: it conflicts with
   repository-wide `>10` run policy and created recurring review blockers.
2. **Treat fingerprint parity as full simulation proof.** Rejected: overstates what
   end-of-run telemetry can guarantee.
3. **Maintain a standalone canonical serializer in the fingerprint module.** Rejected:
   duplicates core serialization logic and increases drift risk against shared hardening.
