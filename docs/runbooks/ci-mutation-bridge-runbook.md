# CI mutation bridge runbook

## Purpose

This runbook documents the single-writer ownership switch and rollback bridge
for PR lifecycle automation during the Goobers migration. Phase 2 moves
claim/lease decisions to Goobers; Phase 3 will move the individual mutation
lanes. The owner selector and bridge always fail closed when they disagree.

## Steady-state operation

| Owner          | Bridge  | Result                                                                         |
| -------------- | ------- | ------------------------------------------------------------------------------ |
| `goobers`      | `false` | Goobers owns PR/head claim and lease decisions; legacy paths are observe-only. |
| `legacy`       | `true`  | Legacy mutation paths are enabled for rollback; Goobers is observe-only.       |
| any other pair | any     | Fail closed: neither owner may write.                                          |

An unset or misspelled owner is intentionally not treated as Goobers. The
Goobers wrapper also re-reads both repository variables immediately before a
lease write, so a run whose ownership changed after its decision cannot mutate.

## When to activate the emergency bridge

Use rollback only for a bounded incident or controlled drill. Setting
`LIFECYCLE_MUTATION_OWNER=off` is the immediate kill switch for new mutations;
drain in-flight lifecycle runs before selecting the replacement owner.

Examples:

- direct PR lifecycle mutation stalls while Goobers is offline or misrouted;
- a critical PR handoff requires an immediate legacy mutation while Goobers is under repair;
- an explicit rollback drill requires a controlled fallback execution.

The legacy implementation remains checked in as the fallback until Phase 4.

## Goobers lease contract

- Scope: one lower-cased `repository#PR@headSHA` key.
- Operations: acquire, heartbeat, and release.
- TTL: `LIFECYCLE_LEASE_TTL_SECONDS` (120–3600, default 300) from the GitHub
  API server timestamp refreshed immediately before the Goobers decision.
- Persistence: one `<!-- crawler-lifecycle-lease:v1 -->` PR comment, registered
  in `.github/scripts/ci-recovery/markers.mjs` with every other managed marker.
- Trust boundary: only lease comments written by trusted authors (GitHub App /
  automation bots, owners, members, collaborators) are counted, so a drive-by
  comment can neither forge an active lease nor poison the lease state.
- Contention: an unexpired different lease wins; the contender emits
  `status=contended` and does not write.
- Takeover: an expired lease or a superseded head is replaced deterministically.
- Corruption: malformed or duplicate managed comments disable writes.
- Trust: fork heads are rejected with `reason=fork`, and a caller head that no
  longer matches the live PR head is rejected with `reason=stale-head` in the
  decision artifact itself, before persistence; the apply step keeps its own
  head fence.
- Configuration: `LIFECYCLE_MUTATION_OWNER` must be exactly `goobers` or
  `legacy` and `LEGACY_CI_MUTATION_BRIDGE_ENABLED` exactly `true` or `false`;
  any other spelling, case, or padding disables both writers.

Each run uploads its input and Goobers decision artifact. The apply step logs a
`LIFECYCLE_OWNERSHIP_DECISION` JSON record containing the status, reason, and
lock key.

## Cut over to Goobers ownership

1. Set `LIFECYCLE_MUTATION_OWNER=off`.
2. Wait for active CI Recovery, Merge Train, and auto-rebase runs to finish.
3. Set `LEGACY_CI_MUTATION_BRIDGE_ENABLED=false`.
4. Set `LIFECYCLE_MUTATION_OWNER=goobers`.
5. Dispatch `Goobers Lifecycle Owner` with `operation=acquire`, the PR number,
   and its exact head SHA.
6. Confirm the artifact reports `status=acquired` and the managed PR comment
   names the same PR/head.
7. Confirm legacy workflow logs say `observe-only` and contain no direct
   lifecycle mutation step.

## How to enable the bridge

After the immediate kill switch and drain, run:

```bash
gh variable set LIFECYCLE_MUTATION_OWNER -R nalfeo/Crawler --body 'off'
# Wait for active lifecycle runs to drain.
gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED -R nalfeo/Crawler --body 'true'
gh variable set LIFECYCLE_MUTATION_OWNER -R nalfeo/Crawler --body 'legacy'
gh variable set CI_RECOVERY_MODE -R nalfeo/Crawler --body 'live'
```

Then validate the workflow logs and confirm the legacy mutation path runs again (with `CI_RECOVERY_MODE=live` for representative mutation coverage).

## Expected behavior while active

- Goobers lease runs report `observe-only` and cannot update their lease comment.
- Legacy mutation code executes as the available rollback path.
- Mutation throughput may be slower than the eventual Goobers-only path.
- Operators must treat the bridge as temporary migration infrastructure and record any changes to its state.

## How to disable the bridge and resume steady state

To return to Goobers claim/lease ownership:

```bash
gh variable set LIFECYCLE_MUTATION_OWNER -R nalfeo/Crawler --body 'off'
# Wait for active lifecycle runs to drain.
gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED -R nalfeo/Crawler --body 'false'
gh variable set LIFECYCLE_MUTATION_OWNER -R nalfeo/Crawler --body 'goobers'
gh variable set CI_RECOVERY_MODE -R nalfeo/Crawler --body 'dry-run'
```

Confirm a Goobers acquire or heartbeat succeeds and all legacy paths report
observe-only. This Phase 2 switch covers ownership/intake only; do not claim
that the four Phase 3 mutation lanes have moved.

## Monitoring and operational checks

Monitor these signals during active incidents:

- `LIFECYCLE_OWNERSHIP_DECISION` status/reason counts, especially contention;
- malformed or duplicate lease warnings;
- merge-train and ci-recovery workflow success rate;
- PR mutation latencies;
- branch update or label application failures;
- any repeated "stalled PR" or recovery queue backlog signals.

If the bridge stays active beyond a short incident window, investigate the Goobers root cause instead of leaving the legacy path enabled.

## Rollback drill sequence

1. Record the test PR and exact head SHA.
2. Set the owner to `off`; verify a Goobers acquire reports `observe-only`.
3. Drain active lifecycle workflows.
4. Enable the bridge, select `legacy`, and set CI Recovery live.
5. Trigger one representative legacy operation and verify it succeeds.
6. Set the owner back to `off` and drain again.
7. Disable the bridge, select `goobers`, and restore CI Recovery dry-run mode.
8. Acquire the Goobers lease for the unchanged test head and verify legacy
   workflows report observe-only.
9. Verify a fork head is rejected with `reason=fork` and neither owner mutates it.

Document the run IDs, timestamps, and the exact mutated PR in the incident or drill record.

## Known limitations

Phase 2 does not transfer merge-train promotion, review-thread closure,
auto-rebase, or CI Recovery state mutations into Goobers. It only makes Goobers
authoritative for the ownership/intake lease and prevents legacy mutation entry
points from running unless the exact rollback pair is selected.

## Post-incident review checklist

- What failed in Goobers?
- Why was the bridge necessary?
- Was the bridge enabled only for the shortest possible window?
- Did the system return to `LIFECYCLE_MUTATION_OWNER=goobers` and
  `LEGACY_CI_MUTATION_BRIDGE_ENABLED=false`?
- Was the root cause recorded and fixed before closing the incident?
