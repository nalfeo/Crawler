# Crawler Goobers Configuration

This directory is Crawler's versioned Goobers desired-state source. It defines
the manual-only `crawler-feature-pr` workflow:

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
