# Session Handoff: Floor 6 hero tower-defense epic

## Date

2026-08-31

## Persona

Content Designer

## Systems touched

ci-policy, docs-tooling, mapgen, quests, enemies, ai-behavior-tree, ai-combat-balance, boss-rooms, hud-ux

## Apples

Estimated: 3🍎; actual: 3🍎

## Summary

Authored the implementation manifest for Floor 6, **Hold for Renovation**, without
adding gameplay, assets, tuning, or runtime data.

- The nine-node DAG starts with a canon-backed design/spec/ADR contract because no
  Floor 6 source package exists yet.
- Runtime work is split into foundation/map, waves/routing, loot/upgrades,
  towers, active hero integration, Deadline finale, presentation/content, and
  evidence-backed balance/release slices.
- Every slice names concrete deliverables, ownership boundaries, dependencies, and
  a real-artifact completion condition.
- The exact-revision epic review is the human gate for the non-numeric design
  decisions. Balance numbers are explicitly deferred until representative runtime
  evidence exists.
- The manifest permits only general genre conventions and requires original names,
  dialogue, maps, art, and expression.

## Canon and workflow provenance traced

- `docs/knowledge/game-design/lore-bible.md` and its official source register.
- `docs/knowledge/game-design/game-design-document.md`, especially the designed
  Floor 4 and Floor 5 entries.
- `docs/knowledge/game-design/floor4-arena.md` for constrained wave-floor precedent.
- `docs/knowledge/game-design/floor5-hostile-takeover.md` and its 2026-08-30 design
  handoff for deterministic pressure, evidence deferrals, and dependency-complete
  issue slices.
- `docs/guides/epic-creation-workflow.md` and the Floor 3–5 epic manifests.
- Recent epic workflow handoffs from 2026-08-24 and 2026-08-25.

No canon conflict was found. The new premise is deliberately provisional inside
the epic review and becomes authored canon only through slice 1's provenance-backed
content package.

## Verification

- `node --test .github/scripts/epics/epic-create.test.mjs` — passed, 31/31.
- `npx vitest run tests/unit/epic-workflow.test.ts` — passed, 2/2.
- `npx prettier --check docs/knowledge/epics/floor-6-hero-tower-defense/floor-6-hero-tower-defense.epic.json`
  — passed.
- `npm run verify:fast` — passed.

`npm run epic:status` and `npm run epic:materialize` were intentionally not used:
they operate the bespoke Floor 2 equipment control plane, not the generic
`*.epic.json` workflow.

## Review

- Separate-model plan review (`gpt-5.4`) returned
  `approved_with_changes`. All three concerns were adopted: self-contained slices,
  foundation-first ordering with presentation and balance last, and correct generic
  epic validation commands.
- Manifest review (`claude-sonnet-4.6`) found no schema, dependency, implementability,
  canon, policy, or scope defects.

## Runtime observation

Not applicable: this session intentionally changed planning documents only. The
manifest requires later behavioral slices to prove their work through the real
windowed/headless ScenarioDefinition pipeline, and requires deterministic game-scale
captures for presentation.

## Next steps

1. Land the manifest through normal repository review.
2. Let Epic Create file the exact-revision human-review issue.
3. A human approves or rejects the named non-numeric design decisions.
4. After approval, materialize the graph and begin only
   `slice-1-design-contract`.

No PR was created, per the user's explicit instruction.
