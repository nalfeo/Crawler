# ADR 0064: Data-Driven Boss Ability Catalog and Separate Delivery Evidence

## Status

Accepted

## Date

2026-07-17

## Estimated Complexity

🍎 x 4 - establishes a durable content/status contract across shared game data,
future simulation, presentation, AI, codex, art, lab, and agent workflow
surfaces without implementing runtime combat yet.

## Context

Floor 2 has 18 family bosses and selects four families per run. Each boss needs a
unique recurring ability with predictable cooldowns, exact visible danger
geometry, an attack announcement, and extravagant VFX. Bosses on other floors
must be allowed to have no ability, and a later slice must let ordinary mobs use
the same executor.

A prose-only plan or a collection of independent GitHub issues would not protect
the 18-boss roster from drift and would not give a future codex a validated
source. Conversely, defining a complete executable combat DSL before one
vertical slice exercises real timing, geometry, status-effect, cleanup, AI, and
rendering constraints would encode guesses as architecture.

The project also needs durable implementation and asset tracking. Those fields
change much more often than stable gameplay/codex content, and browser consumers
should not bundle stale PR states or lab evidence.

## Decision

1. Make `src/shared/data/boss-abilities.floor2.json` the stable, versioned,
   canonical content source. `src/shared/boss-abilities.ts` validates it with the
   existing Zod dependency, cross-checks exact coverage against Floor 2 bosses
   and families, and exposes lookups, announcement formatting, and a codex-safe
   projection.
2. Keep `boss-abilities/v1` descriptive. It encodes exact cadence, target-lock
   rules, cue shape/metrics, effect design values, codex copy, VFX intent, and
   counterplay, but runtime code must not interpret arbitrary strings as
   executable effects.
3. Put volatile delivery and evidence data in
   `scripts/agent/data/boss-abilities.floor2.status.json`, validated and joined by
   `scripts/agent/boss-ability-status-lib.ts`. This Node-only sidecar tracks
   blockers, implementation, art provenance, asset requests, codex icons,
   optional cast animation, and lab evidence without entering the game bundle.
4. Never store an overall delivery stage. `npm run boss-abilities:status`
   derives `designed`, `blocked`, `ready`, `in-progress`, or `verified` from
   explicit gates and evidence axes.
5. Implement abilities incrementally. The first runtime slice is a mob-agnostic
   optional executor plus Queen Mab's Verdigris Glamour. The other 17 complete
   designs remain blocked until a separate production-enable/balance gate is
   resolved (see Amendment 2026-07-17); the shared-foundation and Queen slices
   verifying does not by itself promote them to ready.
6. Reuse the combat arena lab from PR #1243. Every implemented ability needs
   arena proof. While production is gated off, the deterministic arena run
   through the canonical runtime is the authoritative artifact; a real
   game/headless Floor 2 artifact is deferred to the production-enable gate.
   Authored cast animation is optional; if added, it makes sprite-animation-lab
   proof mandatory.
7. Build rather than buy the runtime foundation. Existing ECS state, Zod,
   announcement events, VFX events, and simulation wiring are the necessary
   seams; a third-party cooldown/ability framework would add adaptation and
   determinism risk without solving Crawler-specific cue, AI, ECS cleanup, and
   lab requirements.

## Consequences

### Positive

- Every Floor 2 boss has one validated, codex-consumable design now; missing or
  duplicate entries fail deterministically.
- Stable gameplay content no longer churns when a PR merges, an art request
  changes, or lab evidence is added.
- The first runtime issue is independently implementable without forcing all 18
  mechanics into one risky PR.
- A future generic mob ability executor can reuse timing/cue state without
  depending on boss codex or delivery metadata.
- Runtime art aliases and missing source briefs are represented honestly instead
  of pretending every approved sprite has the same provenance.

### Negative

- Two validated packs must be joined for a complete design-plus-delivery view.
- Descriptive effect values will need a deliberate migration when each mechanic
  receives an executable typed runtime definition.
- Status evidence is repository-authored and can still become stale between
  audits; the audit date and derived command make staleness visible but do not
  query GitHub automatically.

### Risks

- A future implementer could treat generic design-value strings as an unsafe DSL.
  The spec explicitly forbids this and requires typed effect handlers.
- Rendering and damage geometry could diverge if implemented separately. The
  runtime contract requires one committed public geometry state consumed by
  renderer, AI, and resolution.
- Queen could appear complete in the arena while remaining inert in production.
  While the production-enable gate is off, Queen therefore must not derive as
  production `verified`: her runtime/telegraph/arena states are verified from the
  deterministic arena artifact, but she stays blocked behind the open arena PR
  and the `floor2-boss-production-enable` gate until a real headless Seed 42
  repeated-cast artifact is produced at production-enable time.
- The status sidecar could claim proof without an artifact. Schema validation
  requires evidence for verified lab states; review remains responsible for
  checking the artifact itself.

## Alternatives Considered

- **One combined shared JSON file for content and status.** Rejected because
  volatile issue/PR/lab fields would churn the stable catalog and leak
  development metadata into codex/browser bundles.
- **Markdown or GitHub issues as the primary source.** Rejected because prose
  cannot deterministically enforce one-to-one boss coverage, strict timing/lock
  fields, runtime art resolution, or a codex projection.
- **Generate JSON from the readable spec.** Rejected because parsing prose would
  create a fragile second transformation and make the document format part of
  the build contract.
- **Define a complete executable ability DSL now.** Rejected as premature. Queen
  must first validate the real executor's timing, geometry, status-effect,
  presentation, AI, cleanup, and pipeline seams.
- **Implement all 18 abilities in one PR.** Rejected because failures would
  entangle foundation correctness with 18 unrelated mechanics and prevent a
  small, observable vertical slice.

## Amendment 2026-07-17: Arena-only staging for the Queen Mab slice

The Queen Mab vertical slice was re-approved to land **arena-only**, before
Floor 2 balance is final, under issue #1260. This amends decisions 5–6 and the
Queen inertness risk above:

- The reusable mob-ability executor is wired into the canonical production
  simulation path behind an explicit **default-off** feature gate. The real game
  registers zero active boss ability definitions and emits zero casts while the
  gate is off; only the PR #1243 combat arena enables the same canonical path via
  a deterministic `f2-queen-mab` preset.
- The hard success gate is a **deterministic combat-arena run** (two resolved
  Verdigris Glamour casts at 9,000/19,500ms telegraph and 10,500/21,000ms
  resolution) plus a zero-casts-when-off check — **not** a real Floor 2 headless
  balance sweep, which is explicitly out of scope for this slice.
- PR #1237 is no longer a blocker to starting arena implementation. PR #1243
  remains the authoritative arena dependency.
- Delivery honesty: the `boss-ability-foundation` and `queen-mab-vertical-slice`
  milestones become `verified`; Queen's runtime/telegraph/arena states become
  `verified` with arena evidence, but Queen must **not** derive as production
  `verified` while the new `floor2-boss-production-enable` gate is unresolved.
  The other 17 abilities stay blocked behind that same gate and are not promoted
  to `ready` by this slice.
- Generated replacement art is tracked in a strict, versioned, non-blocking
  Node-side manifest (`scripts/agent/data/queen-mab-art-manifest.json`), scoped
  to Queen Mab but extensible to the other 17 abilities. Every required visual
  phase ships a procedural fallback, so no generated art blocks the arena slice.
