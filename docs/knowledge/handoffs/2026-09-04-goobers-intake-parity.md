# 2026-09-04 Goobers intake parity

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## Summary

Closed the Phase 2 Goobers intake-parity gap. Goobers now claims **at least**
every issue the legacy issue-intake reconciler would have picked up, not only
issues a human labeled `goobers:approved`.

The legacy trust/exclusion policy was **extracted, not rewritten**.
`issueIntakeEligibility` was split into a policy-pure
`legacyIntakeCohortEligibility` (no PR payloads, no `telemetry`, opener must be
`nalfeo` / `github-actions[bot]` / a recognized Copilot identity, `automation`
label only with GitHub Actions provenance) plus a thin ownership layer. Both
intake owners now select from that one function, so parity is structural rather
than two selectors kept in sync by hand.

Ownership, while `LIFECYCLE_MUTATION_OWNER=goobers`:

| Issue class                                             | Owner                      |
| ------------------------------------------------------- | -------------------------- |
| `goobers:approved` (any opener)                         | Goobers (`approved`)       |
| Legacy-eligible, unassigned                             | Goobers (`legacy-parity`)  |
| Telemetry / untrusted opener / non-Actions `automation` | nobody (policy exclusion)  |
| Already assigned                                        | legacy (restart lane)      |
| `goobers/status:in-review` / `completed-existing-work`  | Goobers (in flight / done) |

Rollback (`legacy`, unset, or malformed) hands the entire cohort back to legacy
and leaves Goobers with no claim at all — one intake owner in every state, no
no-work gap, no dual writer. The four `LIFECYCLE_OWNER_*` PR-lifecycle selectors
and the legacy CI Recovery / review / rebase / merge-train lanes are untouched.

The assignment carve-out is the subtle part: Goobers only claims unassigned
issues (`requireUnassigned`), so an already-assigned issue must stay with legacy
or the stale-Copilot-session restart lane (`epic-reprocess.mjs`) would become
ownerless.

Dispatch is now immediate for the whole cohort: `goobers-run.yml` subscribes to
`issues: [opened, reopened, labeled]`, and the hourly `37 * * * *` sweep remains
the recovery path for missed webhooks and backlog. The candidate query no longer
pre-filters on `goobers:approved`; it fetches open, unassigned, non-in-review
issues oldest-first and hands the payloads to the canonical selector, which
returns approved issues first, then the parity cohort.

## Files touched

- `.github/scripts/ci-recovery/issue-intake-lib.mjs`
- `.github/scripts/ci-recovery/issue-intake.test.mjs`
- `.github/scripts/goobers/intake-selection.mjs`
- `.github/scripts/goobers/intake-selection.test.mjs`
- `.github/workflows/goobers-run.yml`
- `.github/workflows/issue-copilot-intake.yml`
- `.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml`
- `.goobers/instance.yaml.example`
- `.goobers/README.md`
- `README.md`
- `docs/agent-os/policies/ci-config-knobs.md`
- `docs/runbooks/ci-mutation-bridge-runbook.md`
- `tests/unit/goobers-run-workflow.test.ts`
- `tests/unit/goobers-lifecycle-ownership.test.ts`
- `docs/knowledge/handoffs/2026-09-04-goobers-intake-parity.md`
- `docs/knowledge/metrics/apples/2026-09-04-goobers-intake-parity.json`

## Verification

- `npm run test:guards` (all node test groups, exit 0) — includes the new
  `.github/scripts/goobers/intake-selection.test.mjs` truth table and the
  reworked `issue-intake.test.mjs` (39 passing).
- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts
tests/unit/goobers-lifecycle-ownership.test.ts tests/unit/goobers-contracts.test.ts
tests/unit/goobers-shadow.test.ts` (87 passing)
- `npm run verify:fast`
- `bash -n` / `sh -n` on the generated "Resolve Goobers recovery target",
  "Comment on Goobers run start", and gaggle `query-backlog` scripts.
- CLI smoke against realistic `gh search issues` / `gh issue view` JSON,
  including a bot-login payload (`{"login":"github-actions","is_bot":true}`) and
  a rollback selector.

## Unresolved issues

- **`gh` strips the `[bot]` suffix and reports `is_bot: true` instead.** A raw
  `author.login` compare would have silently dropped the entire
  GitHub-Actions-opened cohort. `normalizeGhLogin` restores the REST form and is
  covered by a dedicated test — do not bypass it when adding another `gh`-fed
  selector.
- The workflow's single pending concurrency slot means a burst of issue events
  can displace a queued run. An `issues` event whose issue is _not_ in the
  cohort now falls through to the recovery sweep instead of exiting, so the run
  is never wasted, and the hourly sweep remains the convergence backstop.
- `Set up Node.js` is deliberately ungated and moved ahead of target resolution:
  the eligibility selector runs on Node, so gating it on the resolve step's own
  output would be circular.

## Recommended next steps

- Watch the first few hourly sweeps after merge: the parity cohort is much
  larger than the approved queue, so the oldest-created open issue in the
  backlog will be claimed first. If that ordering is wrong for the maintainer,
  the fix is the cohort ordering in `selectGoobersIntakeIssues`, not a new
  label filter in YAML.
