# Session Handoff: Floor 6 design contract

## Date

2026-08-31

## Persona

Content Designer

## Systems touched

docs-tooling, mapgen, quests, enemies, ai-behavior-tree, ai-combat-balance, boss-rooms, hud-ux

## Apples

Estimated: 4🍎; actual: 4🍎 — exact: the requested content/spec/ADR package also needed the
GDD, Lore Bible source register, spec catalog, ADR catalog, and full review ledger to be
discoverable and auditable.

## Summary

- Added proposed Floor 6 content bible, deterministic system spec, and ADR 0097 for the original
  compact defense-production set.
- Explicitly distinguished it from Floor 4's survival arena and Floor 5's siege, with no copied
  names, dialogue, maps, art, or distinctive expression.
- Defined proposed Relay defense, phase/terminal precedence, authored non-blocking sites, immutable
  manifests, floor-scoped lifecycle, breaks, Deadline finale, schemas, isolated RNG streams,
  telemetry, ownership, later-slice acceptance mapping, and human decision register.
- Kept all five named non-numeric decisions under `HUMAN_GATE-1` through `HUMAN_GATE-5`; all are
  now approved via [#3963](https://github.com/nalfeo/Crawler/issues/3963), closed completed by the
  human owner. All numeric tuning remains deferred to S9's owner-backed representative evidence.

## Verification

- `npm run verify:fast` — passed.
- `npx prettier --check` on all changed documentation — passed.
- `npx tsx scripts/agent/docs/check-lore-canon.ts` — passed.
- `npx tsx scripts/agent/docs/check-adr-consistency.ts` — completed with one existing,
  non-blocking warning for `2026-08-18-ten-slot-equipment-contract.md`.
- `npm run docs:check` remains blocked before changed-doc checks by a pre-existing stale path in
  `.github/agents/ux-designer.agent.md` (last touched by PR #3957, unrelated to Floor 6). The
  `.github/agents/` directory is off-limits to this agent by environment policy, so fixing it
  requires human access; the individual Floor 6 doc checks (`check-adr-consistency`,
  `check-lore-canon`) pass on their own.
- `npm run review:ledger -- validate ...floor6-design-contract.review-ledger.json` — passed.

## Review

- Adversarial plan review (`gpt-5.4`) produced eight concerns; all were incorporated.
- Code and multi-model reviews found and resolved the S5/S6 acceptance-anchor mismatch; clean
  second rounds followed.
- Independent grade (`claude-opus-4.8`) passed: correctness 5, scope 5, coverage 4, policy 5,
  maintainability 5.

## Runtime observation

Not applicable: this is documentation-only planning work. The spec requires later runtime slices to
observe both real ScenarioDefinition pipelines and S8 to provide deterministic real-game evidence.

## Next steps

`HUMAN_GATE-1` through `HUMAN_GATE-5` are approved via [#3963](https://github.com/nalfeo/Crawler/issues/3963);
S2 implementation may proceed on those five decisions. S9 must separately approve all numeric
values after representative GitHub-backed sweep evidence.
