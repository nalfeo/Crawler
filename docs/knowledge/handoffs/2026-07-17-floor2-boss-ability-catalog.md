# Handoff: Floor 2 boss ability catalog

## Date

2026-07-17

## Persona

Producer

## Systems touched

enemies, boss-rooms, weapons, vfx, ai-behavior-tree, sprite-workflow

## Apples

4🍎 estimated → 4🍎 actual. The change spans stable game data, Node-only
delivery state, schemas, tests, a status CLI, a living spec, and an ADR. Review
evidence is recorded in
`docs/knowledge/review-ledgers/2026-07-17-floor2-boss-ability-catalog.review-ledger.json`.
The complexity record is
`docs/knowledge/metrics/apples/2026-07-17-floor2-boss-ability-catalog.json`.

## Summary

Published the official design and delivery contract for one recurring unique
ability on each of the 18 Floor 2 bosses. This branch intentionally does not
implement runtime ability execution.

Every catalog entry includes:

- a fixed recurring cooldown with zero random jitter;
- locked targeting and explicit telegraph geometry;
- exact attack-name announcement copy;
- effect values, counterplay, codex copy, and gratuitous procedural VFX intent;
- optional cast-animation policy without making authored animation a ship gate.

Queen Mab Tarnish is the first planned vertical slice:

- `VERDIGRIS GLAMOUR — All that glitters will corrode!`
- first eligibility and recurring cooldown: 9 seconds;
- cooldown anchor: resolution;
- telegraph: locked 12-foot hostile-red circle for 1.5 seconds;
- effect: moderate damage plus four-second Tarnished;
- Tarnished: -30% movement speed and -25% attack speed, non-stacking.

## What Changed

- Added `src/shared/data/boss-abilities.floor2.json`, the stable 18-entry
  catalog and future codex source.
- Added `src/shared/boss-abilities.ts`, a strict Zod loader with exact
  boss/family/catalog coverage, lookups, announcement formatting, and a
  delivery-free codex projection.
- Added `scripts/agent/data/boss-abilities.floor2.status.json`, the volatile
  blocker, implementation, art, animation, and lab-evidence sidecar.
- Added `scripts/agent/boss-ability-status-lib.ts` and
  `npm run boss-abilities:status`, which validate the sidecar and derive
  `designed`, `blocked`, `ready`, `in-progress`, or `verified`.
- Added 22 focused tests for roster integrity, exact Queen values, fixed timing,
  geometry completeness, status transitions, animation proof coherence, report
  accuracy, and runtime art-resolver agreement.
- Added `.specify/specs/boss-abilities.md` and ADR 0064, plus their indexes.
- Repaired stale paths and malformed retrospective sections in historical docs
  that the existing documentation gate surfaced.

The current status report derives all 18 abilities as `blocked`. Queen is
blocked by PRs #1237 and #1243. The other 17 are blocked by the reusable
foundation and Queen vertical-slice milestones.

## Key Decisions

1. Stable gameplay and codex content lives under `src/shared`; volatile GitHub,
   art, and lab evidence stays Node-only under `scripts/agent`.
2. Overall status is derived from explicit axes and blockers rather than stored.
3. Catalog v1 is descriptive, not an executable DSL. Runtime mechanics must use
   typed handlers validated by the Queen slice.
4. Dangerous abilities commit exact geometry, including lane length semantics
   and complete annulus dimensions, without making rendering authoritative.
5. Procedural cues and VFX can ship without authored cast animation. Once
   animation is produced, verified sprite-animation-lab evidence becomes
   mandatory.
6. Existing approved generated boss art is reused. Raccoon and imp retain their
   runtime aliases (`raccoons-boss`, `imps-boss`); codex icons remain a
   non-blocking backlog.
7. PR #1243 is the authoritative combat arena lab. Do not create a competing
   arena.

## Review Summary

- Adversarial plan review: 8 concerns resolved; three alternatives considered;
  minor plan divergence.
- Code-review loop: two bounded rounds, two status-state defects fixed, final
  round clean.
- Multi-model review: GPT-5.4 and Gemini 3.1 Pro over two bounded rounds,
  adjudicated by Claude Opus 4.8. Delivery gating, geometry invariants, status
  reporting, and animation-proof coherence were fixed; final round clean.

## Verification

- `npm run verify:fast` — 22 focused tests pass.
- `npm run boss-abilities:status` — all 18 entries validate and report.
- `npm run docs:check` — completed successfully after stale-doc repairs.
- `npm run review:ledger -- validate` — valid 4-apple ledger.

No gameplay runtime was changed, so visual or headless behavior observation is
not applicable to this catalog-only branch.

## Next Implementation Slice

Create one independent implementation issue for the reusable mob-ability
foundation plus Queen Mab:

1. Block execution until Floor 2 durability PR #1237 and combat arena PR #1243
   are available.
2. Build deterministic, Phaser-free typed runtime ability state that can later
   serve generic mobs.
3. Wire the executor into the visual game and every relevant headless/simulation
   pipeline.
4. Implement Queen's exact catalog contract, announcement, hostile-red committed
   circle, damage, Tarnished debuff, public danger state, and excessive VFX.
5. Prove at least two resolved casts in the real Seed 42 Floor 2 headless
   pipeline and capture Queen evidence in the PR #1243 arena.
6. Update the status sidecar so the foundation and Queen milestones become
   verified and the other 17 abilities derive as ready.

## Retrospective

### Lessons Learned

- Separating stable catalog data from volatile evidence prevents GitHub state
  and lab paths from entering the game bundle.
- Derived status needs schema-level coherence checks as well as stage logic;
  review caught several contradictory future states before they became tracker
  debt.
- A staged diff is required before reviewing newly created files. The first
  attempted review was invalid because untracked files were invisible.

### Mistakes Made

- The first code-review attempt ran before new files were staged and therefore
  reviewed the wrong change set. It was discarded and rerun against the full
  staged diff.
- Initial status derivation omitted animation-lab progress/evidence symmetry and
  foundation/blocker verification. The bounded review loops supplied focused
  regressions for each omission.

### Opportunities for Future Improvement

- The Queen implementation should promote repeated-cast, geometry, and
  announcement invariants into reusable deterministic tests for every later
  ability handler.
- Codex icons and optional authored cast animations can be produced
  independently after the runtime foundation is proven.
