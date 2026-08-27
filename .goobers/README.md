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
When an issue is linked to an open PR, the hosted wrapper checks out that PR's
branch and Goobers updates it instead of creating a duplicate. Manual dispatches
can set `issue_number` to select the issue, or `abandon_existing` to close the
attached open PR and intentionally start over. Runtime journals remain outside
this source tree; only retries within one Actions job share its throwaway
instance.

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
