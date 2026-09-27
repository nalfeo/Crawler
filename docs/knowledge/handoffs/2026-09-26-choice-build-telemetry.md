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

## Publication integration follow-up

The user directly authorized push/publication in the coordinator. Rebased onto
current main and preserved both combat-pressure and choice/build diagnostics.
The shared test fixture exactly matches the removed duplicate. Post-sync review
found two evidence issues: final-leg choices in flattened multi-floor records,
and double-counted generated active weapons. Both were fixed with integration
regressions. Multi-leg choice evidence remains unavailable pending aggregation;
generated equipment uses one physical identity across bag/equip transitions.
All 70 focused tests, verify:fast, and verify:pr-prereqs passed after corrections.
Final review evidence is recorded in the PR description.

## CI recovery follow-up

CI failed one Floor 3 wiring assertion because it required loadout dispatch to
be the first statement in its branch. Choice telemetry correctly precedes it.
Reproduced the failure locally, then replaced the whitespace regex with a
TypeScript AST check requiring the same loadout guard and a direct, unconditional
option-0 dispatch statement. No runtime behavior or CI gate changed. The failing
suite and choice/build suite pass (44 tests). Publication checks and independent
review are recorded in the PR description.
