# Crawler Goobers Configuration

This directory is Crawler's versioned Goobers desired-state source. It defines
the `crawler-feature-pr` workflow, dispatched automatically by GitHub Actions
when `goobers:approved` is applied and rediscovered by an hourly recovery sweep:

```text
goobers:approved issue
  -> producer plan
  -> implementer
  -> independent reviewer
  -> npm run verify:fast
  -> ready-for-review PR
```

The workflow never merges a PR. The trusted Issue Copilot Intake workflow
intentionally does not assign Cloud Copilot to `goobers:approved` issues.
Plan, implementation, and review each allow at most two attempts, and the run
allows at most two gate repasses. After implementation commits, the workflow
checkpoints the branch before review so partial progress survives a failed run.
When an issue is linked to an open PR, the hosted wrapper passes its validated
head branch to Goobers. The workflow's claim stage emits Goobers'
`workspaceBranch` output, rebinding every subsequent managed worktree to that
branch instead of creating a duplicate. Manual dispatches can set
`issue_number` to select the issue, or `abandon_existing` to close the attached
open PR and intentionally start over.

Shadow mode is a read-only parity path used during Goobers Phase 1. Its
scheduled workflow reads only the resolved UTC report day's completed CI
Recovery and Merge Train runs, then downloads the immutable PR/head decision
records captured by those legacy runs. Each record includes the actual legacy
outcome plus the contemporaneous lifecycle and review-thread inputs loaded
through CI Recovery's authoritative paginated reader. A capability-empty
`crawler-lifecycle-shadow` Goobers workflow produces the independent dry-run
decisions. The comparison emits stable per-run decisions plus a
`daily-report.json` artifact with an idempotency key. Missing requested workflow
coverage and marker-resolution differences are explicit parity divergences.
The workflow has no write-capable permissions and makes no repository, issue,
or PR mutation call.

Phase 2 adds `crawler-lifecycle-owner`, the authoritative deterministic
claim/heartbeat/release decision path for PR/head leases. The hosted
`goobers-lifecycle-owner.yml` wrapper supplies a GitHub workflow-run timestamp,
serializes on the same per-PR concurrency group as CI Recovery, and revalidates
the live repository, head SHA, owner selector, bridge setting, and current lease
before persisting the decision in one managed PR comment. The Goobers workflow
itself has no GitHub mutation capability. Active contention and malformed or
duplicate lease state fail closed and remain visible in the uploaded decision
artifact.

`LIFECYCLE_MUTATION_OWNER` is an exact owner selector, not a truthy flag.
Goobers writes require `goobers` plus
`LEGACY_CI_MUTATION_BRIDGE_ENABLED=false`; legacy writes require `legacy` plus
the bridge set to `true`. Unset, invalid, or inconsistent combinations disable
both writers. See
[`docs/runbooks/ci-mutation-bridge-runbook.md`](../docs/runbooks/ci-mutation-bridge-runbook.md)
for the drain-first cutover and rollback procedure.
Runtime journals remain outside this source tree; only retries within one
Actions job share its throwaway instance.

## Contract Versions

All invocations and outputs between GitHub Actions and Goobers workflows
conform to versioned schemas documented in
[`docs/knowledge/handoffs/goobers-phase0-mutations-and-contracts.md`](../docs/knowledge/handoffs/goobers-phase0-mutations-and-contracts.md)
and enforced by
[`.github/scripts/validate-goobers-contracts-schema.js`](../.github/scripts/validate-goobers-contracts-schema.js).

**Current version**: `v1`

- **Invocation schema** (`crawler.goobers.invocation/v1`): Workflow dispatch inputs
- **Output schema** (`crawler.goobers.output/v1`): Goobers workflow result payloads
- **Validation**: CI job `.github/workflows/goobers-contract-validation.yml` enforces schema conformance

**Upgrading to v2 (future)**:
When the contract must change, increment to `v2` in the schema definition and
add bidirectional compatibility handling in CI Recovery and Merge Train scripts.
Old invocations in flight will continue using v1 until their workflow runs
complete; new invocations can opt into v2. Validation gates fail closed on
unknown versions.

## Runtime boundary

Do not put tokens, journals, workcopies, scheduler state, or telemetry in this
directory. They belong in the external instance root, currently
`C:\goobers\crawler`.

After this source is merged, stop the Goobers daemon and migrate the external
instance through guided source setup. Validate the source before materializing:

```powershell
Q:\src\Goobers\bin\goobers.exe validate --source-tree .goobers
```

The source gaggle key is `crawler`. Before materializing it, archive or remove
the external instance's legacy `example` gaggle runtime state so the new source
has no stale claims or journals to inherit.

Before applying `goobers:approved`, ensure the issue is not already assigned to
Cloud Copilot. The default-branch intake guard prevents new Cloud Copilot
assignments after the label is present, but it cannot retroactively revoke an
existing Cloud Copilot assignment.
