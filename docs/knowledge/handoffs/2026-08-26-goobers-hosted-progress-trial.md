# Goobers hosted-progress draft trial

## Systems touched

agent-tooling, ci

## Summary

- `goobers-run.yml` defaults to private draft release
  `goobers-dev-6d33b160`, built from Goobers commit
  `6d33b160f8748196c65829b31fd23be0070df4d5`.
- The draft asset `goobers_dev_linux_amd64.tar.gz` is downloaded from this
  repository with `gh release download` authenticated by `CRAWLER_CI_PAT`, then
  checked against the independently verified SHA256
  `4758e471e845925c364621db61bdaddefc4a46f45de65aa1cf8a970e3376adde`.
- The existing public Goobers v0.3.3 download and checksum remain available.
- The run grants `checks: write`, exposes the job-scoped `github.token`, and
  invokes `goobers run --github-progress` so Goobers can project live progress
  into GitHub Checks. This permission does not create or consume additional
  runner jobs.
- The final journal artifact upload remains unchanged and authoritative for the
  durable run record.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts`
- `npm run format:check -- --check .github/workflows/goobers-run.yml tests/unit/goobers-run-workflow.test.ts`
- `npm run verify:fast`

## Follow-up

After this PR merges, manually dispatch `Goobers Run` to exercise the private
draft build. This session intentionally did not trigger the workflow.
