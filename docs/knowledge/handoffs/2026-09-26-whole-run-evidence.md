# Whole-run progression evidence

## Systems touched

ai-combat-balance

## Summary

Added scripts/agent/perf/progression-aggregate.ts and wired winrate-sweep.ts to aggregate supported evidence across attempted floors while retaining unmodified chainedLegs provenance. Combat and quest counters sum, health uses minimum/final semantics, reward and level timestamps receive game/active/frame offsets, and earned XP/levels use per-leg end-minus-start deltas. Independent progression win and budget flags remain runner-owned.

Incomplete, erroneous, misordered or duration-inconsistent chains fail closed. A victorious prefix missing a required trailing floor is not complete evidence. Valid single-leg output retains its existing telemetry; incomplete victorious single-leg prefixes fail closed.

## Validation

Reconstructed the original four-file change from the prior task after its worktree disappeared. Preflight and 16 focused aggregation/boundary tests passed, including after synchronization with main. Independent review found and verified a fix for the single-leg missing-tail bypass. No medium/blocking findings remain in that review. Final fast verification passed with the 16 focused tests. Final PR prerequisites also passed. Fresh Codex review transmission was repeatedly blocked by automatic approval review despite explicit user authorization. The user then explicitly directed PR publication with the completed independent review and validation. No fresh Codex review pass is claimed.

## Limitations

Movement lacks a precise sampled-duration denominator. Item choices include setup/carryover selections. These and other floor-local optional diagnostics remain unavailable at the whole-run boundary and are preserved only in raw legs. Terminal equipment and inventory remain terminal snapshots, not summed counters.

The production-boundary test uses real single-floor runner telemetry with mocked progression. It does not demonstrate a real multi-floor carryover simulation. No gameplay or fun-score evaluator changes are included.

## Remaining work

After publication, CI Recovery owns CI/review follow-up. Broader combat-pressure, power-timeline, choice and crafting diagnostics remain separate scopes.

## Review instruction follow-up

At the user's request, active review instructions now delegate read-only review using the installed $review-agent skill instead of the former Ducky terminology and external review command. Updated AGENTS.md, the review-harness skill and policy, persona guidance, and the existing policy assertion. The review-agent inspection found one remaining line-wrapped reference; it was corrected. Historical handoffs remain records of the earlier workflow.
