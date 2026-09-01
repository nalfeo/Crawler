# CI mutation bridge runbook

## Purpose

This runbook documents the rollback bridge for legacy CI lifecycle mutation paths during the Goobers migration. The repository currently keeps the bridge enabled because Goobers does not yet own all four reconciliation, review-thread, and merge-train mutation lanes. The bridge must remain enabled until those lanes pass Phase 3 soak criteria and the Phase 4 rollback drill and dependency gate are complete.

## Steady-state operation

- `LEGACY_CI_MUTATION_BRIDGE_ENABLED` defaults to `false` in code, but the repository-level variable is currently `true` during migration.
- While the repository-level variable is `true`, direct legacy lifecycle mutations remain available as the rollback path; Goobers is not yet the sole lifecycle owner.
- Do not disable the bridge until all four Goobers mutation lanes pass Phase 3 soak criteria, the Phase 4 rollback drill is complete, and the Phase 4 dependency gate is unblocked.
- After that gate, set the variable to `false` and confirm the workflows skip direct mutation work while Goobers owns the lifecycle path.

## When to activate the emergency bridge

The bridge is already enabled for the migration safety window. Keep it enabled until the Phase 4 exit gate is satisfied; after decommissioning, re-enable it only for a bounded incident or controlled rollback drill.

Examples:

- direct PR lifecycle mutation stalls while Goobers is offline or misrouted;
- a critical PR handoff requires an immediate legacy mutation while Goobers is under repair;
- an explicit rollback drill requires a controlled fallback execution.

Before the Phase 4 exit gate, disabling the bridge is not permitted because it would remove the only implemented fallback for lifecycle mutation lanes.

## How to enable the bridge

Run:

```bash
gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED -R nalfeo/Crawler --body 'true'
gh variable set CI_RECOVERY_MODE -R nalfeo/Crawler --body 'live'
```

Then validate the workflow logs and confirm the legacy mutation path runs again (with `CI_RECOVERY_MODE=live` for representative mutation coverage).

## Expected behavior while active

- Legacy mutation code executes as the available rollback path.
- Mutation throughput may be slower than the eventual Goobers-only path.
- Operators must treat the bridge as temporary migration infrastructure and record any changes to its state.

## How to disable the bridge and resume steady state

Run:

```bash
gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED -R nalfeo/Crawler --body 'false'
gh variable set CI_RECOVERY_MODE -R nalfeo/Crawler --body 'dry-run'
```

Only run this after the Phase 4 exit gate is satisfied. Confirm the workflows resume their default skip behavior and that all four Goobers mutation lanes own the lifecycle path.

## Monitoring and operational checks

Monitor these signals during active incidents:

- merge-train and ci-recovery workflow success rate;
- PR mutation latencies;
- branch update or label application failures;
- any repeated "stalled PR" or recovery queue backlog signals.

If the bridge stays active beyond a short incident window, investigate the Goobers root cause instead of leaving the legacy path enabled.

## Rollback drill sequence

1. Confirm the bridge is currently enabled for the migration safety window, or record the incident that requires re-enabling it.
2. Enable the bridge with `gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED ... 'true'`.
3. Set recovery mode live with `gh variable set CI_RECOVERY_MODE ... 'live'`.
4. Trigger a representative PR lifecycle mutation under the legacy path.
5. Verify the mutation succeeds and workflow logs show both active bridge routing and `CI_RECOVERY_MODE=live`.
6. Disable the bridge again with `gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED ... 'false'`.
7. Restore dry-run mode with `gh variable set CI_RECOVERY_MODE ... 'dry-run'`.
8. If the Phase 4 exit gate is complete, disable the bridge and validate the system returns to Goobers-only steady-state behavior; otherwise leave it enabled.

Document the run IDs, timestamps, and the exact mutated PR in the incident or drill record.

## Known limitations

The emergency bridge is intentionally bounded. Legacy code paths do not carry the full Goobers feature set (for example, newer lifecycle semantics or shepherd-lease flows), so the bridge remains a last-resort recovery lane and not a supported steady-state mode.

## Post-incident review checklist

- What failed in Goobers?
- Why was the bridge necessary?
- Was the bridge enabled only for the shortest possible window?
- Did the system return to `LEGACY_CI_MUTATION_BRIDGE_ENABLED=false`?
- Was the root cause recorded and fixed before closing the incident?
