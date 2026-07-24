# Handoff: Deterministic Equipment Balance Gates

## Date

2026-07-18

## Persona

QA Engineer with Game Designer collaboration and separate-model plan/code review.

## Systems touched

inventory, weapons, ai-combat-balance, devtools, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The durable apple record is
`docs/knowledge/metrics/apples/2026-07-18-equipment-balance-gates.json`.

## Authority and stack

- Authoritative issue: #1567, "Add deterministic equipment DPS and distribution gates."
- Authority correction: #1568 belongs to H1 loadout scoring and was not implemented.
- Branch: `equipment-balance-gates`
- Planned PR base: `nalfeo-d1-deterministic-equipment-generator`
- Exact consumed corrected D1 PR #1565 head:
  `23bdec65ee7a8689d229dd1b7d67e922e5e0bc6b`
- Corrected D1 parent:
  `d858c905c074f77047d5b70d901c07d99ce0a443`
- Required C1 active-weapon snapshot ancestor:
  `b5f88d9824c996fc025d1c2c0fec00f4ddae566d`
- Required C2 sourced-grant ancestor:
  `bdb0e8736afde5c2bfd70cd847e408f469c01e5c`

Local HEAD before implementation, the remote D1 branch, the local target ref, and
the merge-base were all fail-closed against the exact corrected D1 head. Explicit
`merge-base --is-ancestor` checks proved the C1 and C2 prerequisites remain in
the corrected stack. The prior D1 TypeScript narrowing failure is fixed upstream;
this slice does not duplicate or modify that correction.

## What Was Done

- Added a deterministic production-backed balance harness with five fixed build
  cohorts at levels 1, 6, and 11. The cohort spans single-target, AOE,
  cadence/crit, active-ability, and defensive/encumbrance tradeoffs.
- Measured realized aggregate DPS from target-health loss over 600 frames through
  production generated equipment, equip/stat/snapshot/ability behavior,
  canonical floor bootstrap hooks, and the real headless simulation step.
- Isolated active-ability contribution inside the single full encounter by
  summing `CombatEvent.fromActiveAbility` hits at the shared `applyDamage`
  choke point, then deriving weapon/passive DPS from the same RNG sequence.
- Added the hard median gate `[1.7, 2.3]` for both transitions. Measured medians
  are `1.942` for level 1->6 and `1.832` for level 6->11.
- Added actionable diagnostics by build, level, seed, target count, damage/hits/
  crits, active contribution, effective combat stats, equipment config, effects,
  grants, total weight, and encumbrance band.
- Added 54 fixed seeded distribution fixtures covering Common/Uncommon/Rare
  budgets, enhancement `+0..+5`, affix target legality, effect-kind frequencies,
  exact replay, and reordered execution.
- Added `npm run equipment:balance-gate` and a discoverable
  `?lab=equipment-balance-lab` surface using the same canonical harness.
- Kept H1 scoring, merchant/reward UX, AI actions/pathing, bulk content, PLAN,
  epic-state, and D1 tuning outside the slice. No progression tuning or seed
  cherry-picking was required.

Observed in the real headless artifact and live lab. Before I1, D1 had no
aggregate-DPS/distribution acceptance gate. After I1, the focused gate reports
PASS with both constitutional medians and all 54 legality/replay fixtures. Live
browser observation also found and fixed long diagnostic tokens overflowing the
lab report; the final report has no horizontal overflow. Screenshot:
`files/visual-review/equipment-balance-gate-live.png`.

## Key Decisions Made

- Gate the cohort median exactly as issue #1567 specifies rather than requiring
  every intentionally diverse build to remain inside the band.
- Use target-health loss through production systems, never item-damage proxy
  formulas.
- Attribute active-ability DPS from tagged combat events inside the single full
  encounter instead of subtracting a separate comparison run with divergent
  crit/accuracy RNG.
- Use canonical encumbrance snapshots and production equipment grant ownership
  rather than duplicating threshold or ability-source logic in the harness.
- Use independent per-request worlds for reordered distribution checks because
  registry instance IDs intentionally encode generation ordinals.

## Review and validation

- Plan review, `gpt-5.4`: five concerns resolved with minor divergence.
- Code review round 1, `claude-sonnet-4.6`: two concerns resolved, including
  proving positive level-6 active contribution.
- Code review round 2 and final-diff recheck, `claude-sonnet-4.6`: clean across
  correctness, determinism, contracts, security, runtime ownership, performance,
  regression coverage, and policy.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-18-equipment-balance-gates.review-ledger.json`
- Focused gate: 4 tests passed.
- `npm run verify:fast`: passed after the final lab readability fix.
- Deterministic visual suite: 20 tests passed.
- Live lab: PASS, no horizontal report overflow, only the existing favicon 404.
- Azure-backed LLM visual critique was unavailable because
  `AZURE_OPENAI_ENDPOINT` is not configured; this surface is not UX-heavy, and
  deterministic/browser observation remained authoritative.
- No `files/guard-telemetry.jsonl` artifact existed for this session.

## What's Next / Blockers

Publish a ready, non-draft stacked PR targeting
`nalfeo-d1-deterministic-equipment-generator`, closing #1567. Do not merge or arm
auto-merge. There are no implementation blockers.

## Retrospective

### Lessons Learned

The authoritative `npm run typecheck` must run independently for stacked slices:
the earlier fast verifier missed D1's callback-narrowing failure. Paired combat
measurements also need independent worlds and two warmup frames so generated
passives settle before the measured window.

### Mistakes Made

The first local attempt patched D1's narrowing failure before authority was
clarified; that patch was discarded and implementation paused until the D1 owner
published the corrected exact head. The first lab visual-review invocation used
the wrong probe-skip flag, and direct browser geometry then exposed the real
horizontal-overflow issue more quickly.

### Opportunities for Future Improvement

`verify:fast` should fail when its parallel TypeScript child fails, and the visual
review CLI could expose probe-wait guidance in `--help` so text-only labs do not
first spend 45 seconds waiting for game probes.
