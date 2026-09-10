# Fix Goobers reserve sparse checkout

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended** — live issue-triggered runs consistently failed before
  reservation because a directly invoked checked-in selector was absent.
- Apple estimate: **2**

## Summary

Fixed the live `Reserve Goobers recovery target` failure seen in Actions runs
`33946058885` and `33946003724`. The reserve job's sparse checkout contained
only `scripts/agent`, but `Resolve Goobers recovery target` invokes
`.github/scripts/goobers/intake-selection.mjs`. That selector in turn imports
`../ci-recovery/issue-intake-lib.mjs` (which imports `state.mjs` and
`markers.mjs`), and a cone-mode checkout of `goobers` alone would not populate
the sibling `ci-recovery` directory.

**The workflow repair itself landed on main first**, via PR #4295 (`63a2b88`),
which widened the reserve cone to the whole `.github/scripts` directory. That
covers both `goobers` and the transitively imported `ci-recovery`, so this
branch merged main and kept main's cone verbatim — the workflow is now
byte-identical to main and this PR makes no further workflow change.

Audited every sparse checkout in `goobers-run.yml`. The only other sparse job,
`release-unstarted-reservation`, directly references only
`scripts/agent/goobers-reservation-lease.sh`, which its existing
`scripts/agent` checkout already includes.

What this PR still contributes is the stronger deterministic regression: a
structural workflow test that enumerates every sparse job, extracts checked-in
`.github/**` and `scripts/**` file references from all following shell steps,
verifies those files exist, walks the **transitive** relative-import graph of
every referenced module (statement, multi-line named, dynamic `import()` and
`require()` forms), and verifies each resulting file is covered by the declared
sparse checkout. Its failure message names the job, missing path, current
checkout paths, and remediation. Verified negatively before the merge: with a
`goobers`-only cone it fails with `"reserve" needs
".github/scripts/ci-recovery/issue-intake-lib.mjs" at run time (directly or via
an import chain)`. It coexists with main's narrower
`checks out the canonical selector before every job that invokes it` test,
which only pins the directly invoked selector path.

## Validation

- Parsed `.github/workflows/goobers-run.yml` and ran `bash -n` over every
  extracted shell step in both sparse jobs.
- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts
tests/unit/goobers-run-slot-cleanup.test.ts
tests/unit/goobers-contracts.test.ts --reporter=dot` — 144 passed, 2
  platform-gated skips.
- `npm run verify:fast`

## Apples

Actual: **2** — exact estimate; the repair stayed within the workflow and its
focused deterministic regression coverage.
