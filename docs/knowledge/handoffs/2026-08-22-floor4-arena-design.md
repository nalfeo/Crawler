# Session Handoff: Floor 4 — The Main Event (arena floor design)

## Date

2026-08-22

## Persona

Content Designer (floor design) — docs-only design session for issue #3272.

## Systems touched

mapgen, enemies, boss-rooms, quests

## Apples

3🍎 estimated, 3🍎 actual (docs-only design session; the Floor 4 **epic** it specifies is
5🍎 — see ADR 0090).

## What Was Done

Authored the Floor 4 design triad for issue #3272 ("10 minute arena, brotato like").
No runtime code: this session produces the design contract that implementation slices
build against, following the Floor 3 precedent.

- `docs/knowledge/game-design/floor4-arena.md` — content bible. Floor 4 is "The Main
  Event", a live pay-per-view arena broadcast: five two-minute acts, a **Headliner** boss
  closing each act, and a **Green Room** intermission where rotating sponsors sell goods
  (the in-fiction reason shop stock re-randomizes every visit). Includes the nine-entry
  graded Headliner roster, wave escalation table, economy targets, failure feel, and the
  HUD surface inventory.
- `.specify/specs/floor4-arena.md` — system contract: 11 requirement groups (arena clock,
  phase machine with a total transition table, waves, Headliners, Green Room, shop stock,
  determinism, floor integration, map, headless/telemetry, Floor 3 co-star), 7 design
  decisions, an 8-slice epic decomposition, a test plan, and constitutional compliance.
- `docs/knowledge/adr/0090-floor4-arena.md` — the cross-system architecture: 8 decisions
  and 6 rejected alternatives.
- Index updates: `.specify/specs/README.md`, `docs/knowledge/adr/README.md` (by-number row
  - Floors thematic entry), the GDD's Floor Design section (Floors 3 **and** 4 were both
    missing), and the lore bible's floor-identity source register.

Observation note: there is nothing runtime to observe — this session ships zero code.
Every slice in the spec's Epic decomposition carries a "done when" that names a **real**
artifact (`npm run dev` or the headless runner), never a lab, per project rule #9.

## Key Decisions Made

- **One arena clock, running continuously through waves _and_ boss fights**, additive to
  `world.elapsedMs` (never replacing or pausing it). The first draft froze the clock during
  Headliner fights so "ten minutes" meant ten minutes of wave combat; the adversarial plan
  review classified that as a `major_fork` — it makes the floor's real duration and
  difficulty unknowable and an unbounded boss phase cannot be headless-gated. Rejected.
- **Bounded overtime** as the boss failure path: if an act's mark passes with the Headliner
  alive the clock holds (bleeding into the next act would corrupt the fixed wave schedule),
  a deterministic escalation ramp runs, and a hard 60s cap ends in a lethal finisher. The
  floor's worst case is therefore a number: 600k ms + 5 × 60k ms.
- **A single `arenaDirectorSystem` owns the phase machine**; every other system reads phase
  and none infers it from world contents (explicitly unlike `floor2ObjectiveTick`). Must be
  wired into both `src/engine/sim/simulation-step.ts` and `src/game/ai/simulation-step.ts`
  per rule #14 / ADR 0039.
- **Precomputed immutable wave manifests + capped, phase-cleared spawn debt**, with fixed
  indexed gates and no retry-based placement — so cap pressure and player behavior can
  never perturb RNG consumption.
- **Isolated derived RNG streams per purpose**, never the shared `world.rng`. The
  player-facing consequence is that Green Room stock is **path-independent**: visit _n_ for
  a seed is identical no matter how the acts went, so shopping is a build decision rather
  than an RNG-manipulation minigame.
- **The intermission is an ordered transaction**, not a doorway (`src/core/safe-space.ts`
  only sets a flag — it does not clear enemies, stop projectiles, or pause anything).
- **Headliner encounter identity is the act slot**, not the archetype; the candidate pool is
  append-only and stably ordered because reordering changes every existing seed's card.
- **Explicitly out of scope:** paid shop re-roll, audience-vote mutators, destructible
  fixtures, procedural arena geometry.

## What's Next / Blockers

- No blockers. Next step is spec slice 1 (floor plumbing + authored arena map), then slice 2
  (phase machine + clock + a **minimal headless route**, deliberately pulled early so the
  later slices are validated rather than assumed).
- Open items the implementation must settle with evidence, not opinion: final budget/threat
  numbers, the win-rate target, and per-act income budgets — all set by slice 7 against a
  seed sweep, never by rescuing individual seeds (rule #12).
- Floor 4 is the **consumer** of Floor 3's kept-Companion carryover, which Floor 3's spec
  left open. It is specified here as a strictly additive optional slice (slice 8): balance
  must hold with no co-star.

## Retrospective

### Lessons Learned

- The adversarial plan review paid for itself outright. The frozen-clock model looked clean
  in isolation and was the single worst decision in the draft; a separate model caught it
  before a word of the spec was written. Running the plan review _concurrently_ with drafting
  the content bible (rather than serially) cost nothing and still caught the fork early
  enough to rewrite only three sections.
- A docs-only diff is exempt from the review-ledger requirement — `.github/extensions/
copilot-guards/lib/pr-scope.mjs` classifies **any** `.md`/`.txt` outside `src/` as docs,
  including `.specify/specs/*.md`. That exemption is about the guard, not about rigor: the
  plan review was still worth running for a 3🍎 design session.
- When designing a floor, read the _manifest schema_ (`src/shared/floor-manifest.ts`) before
  the scenario files. It is strict Zod, so it tells you exactly which floor-specific config
  is expressible and which needs a new block — and it surfaces overloaded fields like
  `timer.durationMs` (a deadline for Floors 1–2) that a new floor may need to redefine.

### Mistakes Made

- Drafted the timing model from the issue's literal wording ("survive against waves for 10
  minutes") without first asking what makes the floor _bounded_, which is the property the
  headless win-rate gate actually needs. Early signal I ignored: I wrote "boss fights are
  untimed" and "intermission is untimed" in the same section and did not notice that the
  floor then had no upper bound at all. Next time, for any timed-mode design, write the
  worst-case duration expression **first** and check it is finite.
- Initially framed the paid shop re-roll as a planned final slice. It is a whole extra
  economy/RNG/UI/headless-decision surface for a feature the brief never asked for; the plan
  review was right to call it premature. It is now recorded as explicitly out of scope so it
  is not silently re-invented.
- Wrote three requirements that asserted behavior the existing code does not have, and only
  caught them because a second review round checked the spec against the source rather than
  against itself: the Green Room was described via `spawnRoomIsSafe` (which protects only
  `floorMap.spawnRoom` — the arena) instead of `RoomRole.SAFE`; "no timer in the Green Room"
  ignored that `resolveFloorTimerRemainingMs` derives from `world.elapsedMs`, which keeps
  advancing while shopping; and generated shop offers were specified as "instantiated only on
  purchase" when `quartermaster-stock.ts` already generates at roll time and retires unsold
  instances. Lesson: when a spec claims to _reuse_ an existing system, open that file and
  quote its actual behavior — "reuse" written from memory is how a spec quietly becomes a
  rewrite.
- Let a self-contradiction survive the first draft: the state table ended an act on the boss
  kill while the prose insisted act marks were absolute, which would have made a fast act 5
  win at 9:35 on a floor advertised as ten minutes. Resolved with the victory lap (act always
  ends on its mark; the leftover window is chest/loot collection), which also removed the
  need for a separate "chest resolved before transition" ordering rule.

### Opportunities for Future Improvement

- `docs/knowledge/adr/README.md` is materially stale: the by-number table stops at 0072 while
  0073–0089 exist on disk, and the "Count: 150 ADR files — 107 numbered" header is wrong (207
  files, 205 numbered). A small script could generate the by-number table and count from the
  filesystem, the way `docs:index` already does for handoffs, and remove a recurring source
  of hand-maintenance drift.
- The GDD's Floor Design section had no Floor 3 entry despite Floor 3 having a full content
  bible, spec, and ADR — a floor design can land without the top-level roadmap noticing.
  Worth a docs-check rule: every `floorN-*.md` content bible must be linked from the GDD.
