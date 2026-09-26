# Crafting diagnostics evidence adapter

## Date

2026-09-26

## Persona

QA Engineer

## Systems touched

Tooling only; no runtime systems changed.

## What Was Done

Added a standalone typed crafting evidence adapter and 17 deterministic fixtures.
It describes consumed resources, transaction and output-instance provenance,
active-time acquisition/equip/use windows, rejected opportunities, and matched
before/after effectiveness observations. Missing observations remain distinct
from measured zero. Contradictory evidence is rejected.

Runtime evidence is unavailable because there is no recipe/craft transaction
producer. Synthetic fixtures exercise the adapter; no gameplay or visual wiring,
tuning, human data, or fun-score changes are included. Before/after differences
describe association, not causation.

## Key Decisions Made

Kept diagnostics independent of RunStats and enjoyment scores, consistent with
ADR 0110 and the experience-evaluator evidence-integrity handoff. Costs belong
to transactions and are not multiplied by output count. Starting items retain
separate provenance.

## Validation

The implementation session passed preflight, verify:fast, and all 17 focused
fixtures. Scope selected coverage without gameplay or visual flags. Independent
correctness review and local Ducky review found no actionable defects in the
adapter and fixtures. Publication checks and final complete-diff review are
recorded in the PR.

## What's Next / Blockers

Publish the ready PR and release local ownership to CI Recovery and the merge
train. Future runtime reporting needs a real transaction producer and complete
opportunity/use sensors before supplying runtime evidence. No guard telemetry
artifact existed during implementation.

## Retrospective

### Lessons Learned

Typed synthetic evidence permits deterministic validation without suggesting
that missing runtime sensors measured a zero result.

### Mistakes Made

The initial implementation session exceeded its telemetry budget before
publication; continuation preserved its exact files and validation evidence.

### Opportunities for Future Improvement

Add runtime instrumentation only with explicit transaction and item-instance
identities and observation coverage, then validate it in a real run.
