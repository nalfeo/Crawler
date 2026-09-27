# Choice and build telemetry

## Systems touched

Headless AI runner, automatic progression observation, choice/build diagnostics,
fun-score evidence, change-scope classification.

## Result

Timestamped offer snapshots record selectable options, known constraints, costs,
and budgets. Successful boss-spell callbacks, vendor ledger purchases, and exact
quartermaster stock transitions record confirmed selections. Floor 3 poaching
records submitted intent only. Build snapshots cover weapon, generated equipment,
owned/active spells and abilities, and passive abilities using stable catalog keys.
Starting inventory is excluded from acquisition credit and acquired identities;
historical maxima prevent remove/reacquire inflation. Learned/owned spell overlap
is counted once. Duplicate events cannot replace the final build at tied timestamps.

Evidence is diagnostic only: choice_depth, run_distinctness, and sameness stay null;
existing win and score gates remain unchanged. Scenario copies receive one vote,
conflicting copies are excluded, and malformed/truncated evidence has no identity.
No human data or gameplay tuning was added. Explicit telemetry-file UX exclusions
are preserved; auto-progression still routes to game UX checks.

Coverage remains partial. Crafting transactions, reward-bundle choices, automatic
fallback boss grants, and legacy equipment selections are not covered. Vendor game
time is exact; active time is sampled on first observation. The recorder retains
at most 2048 events and reports dropped events. Counts describe observations, not
independent choice opportunities or enjoyment.

## Validation

- Restored all ten original files from archive snapshot d9fcf202d; verified blob
  hashes before changes. Snapshot ref remains intact.
- 180 focused tests passed across telemetry, fun-score, quartermaster, and scope.
- Fast verification passed: 112 test files / 1877 tests plus type/lint and guards.
- Seed 42, sword, 600-frame runtime probe before/after: all gameplay RunStats were
  identical after excluding wallTimeMs and the new choiceBuildTelemetry field.
- Independent post-diff review found a duplicate-final-build bug; fixed with a
  tied-timestamp regression, and independent re-review passed.
- Local Codex review found stale quartermaster eligibility could hide successful
  purchases after maintenance adds gold/capacity; fixed with a real-purchase test.
  Final local review and publication checks are recorded in the PR.
- Pre-publish sync deferred on dirty worktree without changing HEAD. No guard
  telemetry input file existed to capture.

## Ownership and follow-up

Producer coordination and QA validation continued the previously authorized
implementation. Publish ready for review, then release immediately to CI Recovery;
the merge train owns landing. Do not wait locally for CI or auto-merge.
