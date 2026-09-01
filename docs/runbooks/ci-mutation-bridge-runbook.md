# CI mutation bridge runbook

## Purpose

This runbook documents the bounded emergency bridge for legacy CI lifecycle mutation paths. The steady-state contract is: PR lifecycle orchestration runs through Goobers. Legacy `ci-recovery` and `merge-train` mutation paths remain available only when explicitly enabled for emergency recovery or a controlled rollback drill.

## Steady-state operation

- `LEGACY_CI_MUTATION_BRIDGE_ENABLED` defaults to `false`.
- In steady state, direct legacy lifecycle mutations in `.github/workflows/ci-recovery.yml`, `.github/workflows/merge-train.yml`, and `.github/workflows/auto-rebase-prs.yml` are skipped.
- Goobers owns the lifecycle path: approval routing, PR mutation dispatch, label management, rebase coordination, and recovery queueing.
- Operational signal: the workflow logs should say the bridge is disabled and explicitly skip direct mutation work.

## When to activate the emergency bridge

Enable the bridge only for a bounded incident when the steady-state Goobers mutation path is failing in a way that blocks recovery and the legacy code is the only known recovery path.

Examples:

- direct PR lifecycle mutation stalls while Goobers is offline or misrouted;
- a critical PR handoff requires an immediate legacy mutation while Goobers is under repair;
- an explicit rollback drill requires a controlled fallback execution.

Emergency bridge activation is not a normal operation. The default is to leave it disabled and investigate the Goobers path.

## How to enable the bridge

Run:

```bash
gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED -R nalfeo/Crawler --body 'true'
gh variable set CI_RECOVERY_MODE -R nalfeo/Crawler --body 'live'
```

Then validate the workflow logs and confirm the legacy mutation path runs again (with `CI_RECOVERY_MODE=live` for representative mutation coverage).

## Expected behavior while active

- Legacy mutation code executes as a fallback path.
- Mutation throughput is slower than the normal Goobers path.
- All direct mutation workflows remain on a bounded, emergency-only path.
- Operators should treat the bridge as temporary and document the incident.

## How to disable the bridge and resume steady state

Run:

```bash
gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED -R nalfeo/Crawler --body 'false'
gh variable set CI_RECOVERY_MODE -R nalfeo/Crawler --body 'dry-run'
```

After disabling, confirm the workflows resume their default skip behavior and that Goobers owns the lifecycle path again.

## Monitoring and operational checks

Monitor these signals during active incidents:

- merge-train and ci-recovery workflow success rate;
- PR mutation latencies;
- branch update or label application failures;
- any repeated "stalled PR" or recovery queue backlog signals.

If the bridge stays active beyond a short incident window, investigate the Goobers root cause instead of leaving the legacy path enabled.

## Rollback drill sequence

1. Confirm the bridge is currently disabled.
2. Enable the bridge with `gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED ... 'true'`.
3. Set recovery mode live with `gh variable set CI_RECOVERY_MODE ... 'live'`.
4. Trigger a representative PR lifecycle mutation under the legacy path.
5. Verify the mutation succeeds and workflow logs show both active bridge routing and `CI_RECOVERY_MODE=live`.
6. Disable the bridge again with `gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED ... 'false'`.
7. Restore dry-run mode with `gh variable set CI_RECOVERY_MODE ... 'dry-run'`.
8. Validate the system returns to the Goobers steady-state behavior without incident.

Document the run IDs, timestamps, and the exact mutated PR in the incident or drill record.

## Known limitations

The emergency bridge is intentionally bounded. Legacy code paths do not carry the full Goobers feature set (for example, newer lifecycle semantics or shepherd-lease flows), so the bridge remains a last-resort recovery lane and not a supported steady-state mode.

## Post-incident review checklist

- What failed in Goobers?
- Why was the bridge necessary?
- Was the bridge enabled only for the shortest possible window?
- Did the system return to `LEGACY_CI_MUTATION_BRIDGE_ENABLED=false`?
- Was the root cause recorded and fixed before closing the incident?
