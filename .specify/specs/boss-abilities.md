# Spec: Boss Abilities

> **Status:** Partial
> **Last reconciled:** 2026-07-17
> **Estimated complexity:** 🍎🍎🍎🍎
> **Related ADRs:** [0064-data-driven-boss-ability-catalog](../../docs/knowledge/adr/0064-data-driven-boss-ability-catalog.md)
> **Code source-of-truth:** `src/shared/data/boss-abilities.floor2.json`,
> `src/shared/boss-abilities.ts`,
> `scripts/agent/data/boss-abilities.floor2.status.json`,
> `scripts/agent/boss-ability-status-lib.ts`
> **Labs:** the combat arena lab tracked by
> [PR #1243](https://github.com/nalfeo/Crawler/pull/1243)
> **Test suites:** `tests/unit/boss-ability-catalog.test.ts`; future runtime work
> must add integration, headless, and deterministic visual coverage
> **Known implementation gaps:** the reusable runtime foundation and the Queen
> Mab arena-only vertical slice are implemented and verified in the combat arena.
> Production activation remains gated off by
> `floor2-boss-production-enable`; the other 17 Floor 2 abilities remain blocked
> until their own runtime slices land.

## Context

Floor 2 has 18 authored family bosses and selects four families for each run.
Every Floor 2 boss needs one thematic signature ability, while bosses elsewhere
must be allowed to have no ability. These are recurring battle moves on fixed,
predictable cooldowns - never opener-only attacks.

The system must make dangerous actions readable before they resolve. Projectile
and melee attacks show their exact direction and footprint with hostile-red
arrows, lanes, cones, circles, annuli, or arcs. Every cast announces
`<ATTACK NAME> — <announcement text>` and uses deliberately excessive VFX.

This boss-first slice must not create a boss-only runtime dead end. The eventual
executor and deterministic cue state need to be usable by ordinary mobs later,
while boss membership, codex content, spectacle, and delivery tracking remain
optional boss-specific layers.

## Requirements

### Content and cadence

1. **BA1 - Complete roster:** every `isBoss: true` archetype in
   `src/shared/data/enemies.floor2.json` has exactly one catalog entry, and no
   non-boss or unknown archetype has one.
2. **BA2 - Optional membership:** the future runtime does not assume every boss
   or every mob owns an ability.
3. **BA3 - Recurring fixed timing:** each ability has a positive
   `firstEligibleAfterMs`, a positive `cooldownMs`, `cooldownAnchor:
"resolution"`, and `randomJitterMs: 0`.
4. **BA4 - No hidden retargeting:** all non-self danger geometry locks its target,
   direction, and origin at telegraph start. It never follows the player after
   lock. Self-buff and defense cues may follow their caster.
5. **BA5 - One active cast:** an entity cannot overlap two casts of the same
   ability. Death, despawn, recycled entity IDs, encounter deactivation, and
   invalid targets cancel and clean all owned state.

### Telegraph, announcement, and spectacle

6. **BA6 - Exact danger geometry:** projectile, melee, movement, summon, and
   damaging-zone abilities render the same hostile-red committed geometry used
   by damage resolution and AI danger reasoning. A renderer approximation is
   not authoritative.
7. **BA7 - Persistent readability:** an active damaging zone keeps an exact
   danger rim or footprint visible for its full lifetime.
8. **BA8 - Announcement:** cast start queues the exact attack name and
   announcement text from the catalog. Repeated casts announce repeatedly, but a
   catch-up step must not duplicate one cast's announcement.
9. **BA9 - Gratuitous VFX:** cue, resolution, persistent state, and cleanup use
   deterministic data-only VFX events. Phaser remains a rendering consumer and
   never owns combat state.
10. **BA10 - Animation is optional:** procedural telegraphs and VFX are enough to
    ship. If authored cast animation is later added, sprite-animation-lab proof
    becomes mandatory before that entry is verified.

### Runtime and future reuse

11. **BA11 - Mob-agnostic executor:** runtime execution belongs in a separate
    deterministic mob-ability system, not in the already-large enemy AI system
    and not in a boss-specific switch statement.
12. **BA12 - Real pipeline wiring:** the executor must run in the visual game and
    every relevant headless/simulation pipeline. Lab-only invocation does not
    prove wiring.
13. **BA13 - Shared public state:** rendering and production AI consume the same
    committed cue state. Production AI gets no privileged prediction.
14. **BA14 - Layering:** simulation and event contracts remain Phaser-free.
    Engine code renders public state and drains presentation events.
15. **BA15 - Determinism:** all pattern alternation and offsets are derived from
    explicit cast state or `SeededRandom`; `Math.random()` and wall-clock time are
    forbidden.
16. **BA16 - Descriptive v1 catalog:** `boss-abilities/v1` is an approved design
    and codex contract, not an executable combat DSL. Runtime definitions may
    reference it, but may not interpret arbitrary `designValues` as unchecked
    executable instructions.

### Delivery and evidence

17. **BA17 - Separate lifecycle data:** volatile issue, PR, art, implementation,
    and lab evidence lives in the Node-only status sidecar, not in the browser
    catalog bundle.
18. **BA18 - Derived stage:** overall delivery stage is computed from design,
    foundation, runtime, VFX, blockers, and required lab evidence. It is never a
    hand-authored truth field.
19. **BA19 - Arena proof:** every implemented ability is exercised in the
    canonical combat arena lab from PR #1243. Do not create a second arena.
20. **BA20 - Real observation:** every runtime slice records a deterministic
    artifact proving the ability ran through the canonical simulation pipeline.
    While production activation is gated off, the arena run driving the canonical
    runtime is the authoritative evidence; a separate real-game/headless Floor 2
    artifact is deferred to the production-enable gate and is not required here.

## Design

### Stable catalog

`src/shared/data/boss-abilities.floor2.json` is the canonical content source. Its
strict Zod loader:

- versions the pack as `boss-abilities/v1`;
- enforces unique ability, boss, and family IDs;
- validates exact one-to-one Floor 2 boss coverage and display-name/family
  consistency;
- stores codex copy separately from implementation-facing timing, targeting,
  telegraph, effect, and presentation design;
- exposes boss/ability lookups, announcement formatting, and a codex-safe
  projection that contains no delivery metadata.

The high-level geometry vocabulary is intentionally small and descriptive:
lanes, cones, circles, annuli, multiple circles, sequential annuli, radial
projectiles, rotating arcs, lane-plus-circle routes, spawn circles, self auras,
and contracting annuli. Each shape carries named metrics in feet, degrees,
milliseconds, or counts. The runtime foundation must promote only the primitives
it actually executes into checked runtime types.

### Delivery sidecar

`scripts/agent/data/boss-abilities.floor2.status.json` is the authoritative
delivery/evidence record. It tracks:

- design, shared-foundation, and runtime implementation axes;
- runtime-resolved boss brief ID, approved asset ID, committed brief evidence,
  asset request, and wiring state;
- procedural telegraph/VFX progress and optional asset requests;
- codex icon and cast animation backlog;
- arena-lab and conditional animation-lab evidence;
- implementation issue/PR references;
- external and internal blocker gate IDs.

`npm run boss-abilities:status` validates both packs, joins them by ability ID,
derives the overall stage, and prints all 18 entries. An unfinished backlog exits
successfully; invalid or incomplete data fails during strict parsing.

### Approved Floor 2 roster

The JSON catalog is authoritative for every field. This table is the readable
index, not a second tuning source.

| Boss                      | Ability                     | Fixed cadence       | Cue                                            | Result and counterplay                                                 |
| ------------------------- | --------------------------- | ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| Nana Snaggle Grubwix      | **SCRAP-CART STAMPEDE**     | 8s after resolution | 1.25s locked red lane                          | Charge and strong knockback; sidestep perpendicular                    |
| Don Paco 'The Gob'        | **THE BIG GOB**             | 9s                  | 1.4s locked 70-degree cone, five paths/circles | Five caustic globs and 4s slicks; exit laterally/behind                |
| Big Panda Wei             | **BAMBOO-FED BERSERK**      | 10s                 | 1.5s themed self aura                          | 4s +40% move/melee and heavy knockback resistance; punish then kite    |
| Queen Mab Tarnish         | **VERDIGRIS GLAMOUR**       | 9s                  | 1.5s locked 12ft circle                        | Damage + 4s Tarnished (-30% move, -25% attack speed); leave the circle |
| King Skritt the Unburnt   | **ROMAN-CANDLE CORONATION** | 8s                  | 1.3s, twelve red radial paths                  | Twelve straight shots, alternating 15-degree offset; use spoke gaps    |
| The Sovereign Cap         | **SOVEREIGN SPORE BLOOM**   | 9s                  | 1.6s, three locked 8ft circles                 | Impact + 4s toxic clouds; route around persistent rims                 |
| Big Mama Bufo             | **TONGUE REPOSSESSION**     | 8s                  | 1.25s locked 30ft narrow lane                  | Damage + pull to 5ft; sidestep and punish the miss                     |
| Overseer Fizzwick         | **CLOCKWORK KILL-SAW**      | 9s after return     | 1.3s double-arrow lane                         | Outbound and return damage; stay out through the return                |
| Plague-Boss Squick        | **UNDERCITY MOB CALL**      | 11s                 | 1.5s, three spawn circles                      | Summon three, ability-owned cap six; clear minions between calls       |
| Abuela Saguaro            | **ABUELA'S THORN RING**     | 9s                  | 1.4s 6-15ft annulus                            | Damage + outward knockback; choose the close or far safe region        |
| Countess Vesper           | **MIDNIGHT RESONANCE**      | 10s                 | 1.2s, three ordered annuli                     | Inner-to-outer bursts every 0.35s; cross behind detonations            |
| Kingpin Molt              | **SHELL COMPANY LOCKDOWN**  | 11s                 | 1.2s themed shell aura                         | 3.5s 70% damage reduction + knockback immunity; hold cooldowns         |
| The Broodfather           | **CHITIN TURNOVER**         | 9s                  | 1.2s 100-degree arc + rotation arrow           | 360-degree sweep over 1.6s, direction alternates; move against it      |
| Foreman Grubbs            | **UNDERMINE THE UNION**     | 9s                  | 1.3s locked lane + endpoint circle             | Burrow then erupt; leave both route and endpoint                       |
| Boss Bandit Rocco         | **HIGHWAY ROBBERY**         | 9s                  | 1.2s locked dash lane                          | Damage + steal up to 10 recoverable gold; sidestep or reclaim          |
| Don Honkrado the Godgoose | **OMERTA HONK**             | 9s                  | 1.5s locked 120-degree cone                    | Damage, knockback, 3s -20% outgoing damage; move behind/outside        |
| Foreman Scorch            | **HELLFIRE SHIFT LINE**     | 10s                 | 1.5s locked full-arena line                    | Impact + 4s fire wall; cross before ignition or route around           |
| The Gastropod Godfather   | **THE LONG SQUEEZE**        | 11s                 | 1.25s contracting 24ft-to-5ft annulus          | 2.5s moving damage rim + 4s slow; cross once on favorable terms        |

### Runtime foundation contract

The first implementation issue must add a reusable, optional mob-ability
executor and only one concrete ability: Queen Mab's Verdigris Glamour.

The executor owns per-entity cast phase, eligibility timestamp, cast ordinal,
committed target/origin/direction, cue geometry, and owned spawned entities or
zones. The executor must:

1. enter telegraph only when the encounter is active and no cast is in progress;
2. commit geometry once and expose it to renderer, AI, and resolution;
3. resolve once, emit presentation events once, and anchor the next cooldown to
   resolution;
4. clean state and owned entities on every invalidation path;
5. use cast ordinal for deterministic alternating patterns;
6. be wired through the canonical visual and headless simulation steps.

The catalog remains optional metadata. Runtime definitions should use explicit
typed effect handlers, not evaluate arbitrary strings or generic design values.
That boundary lets ordinary mobs reuse the executor later without inheriting
boss codex, art, or delivery concerns.

### Queen Mab vertical slice

Queen Mab is selected because Floor 2 Seed 42 includes faeries and because she
proves area geometry, debuffs, announcements, VFX, and shared AI/render danger
state without requiring authored animation.

Acceptance (arena-only staging mode):

This slice was re-approved to land arena-only, before Floor 2 balance is final.
The runtime is present in the canonical pipeline but default-off in the real
game; only the combat arena lab enables it. PR #1237 is no longer a blocker to
arena implementation. PR #1243 (the combat arena lab) was squash-merged into
`main` on 2026-07-17T18:48:05Z and is no longer a blocking dependency.

1. Base the implementation on `main` (which already contains the combat arena
   lab from the squash-merge of PR #1243 on 2026-07-17) plus the approved
   catalog/design commit. **✅ DONE** — implemented in PR #1273.
2. No cast becomes eligible before 9,000ms of active boss combat.
3. At eligibility, the exact announcement is
   `VERDIGRIS GLAMOUR — All that glitters will corrode!`.
4. One 12ft circle locks at the player's position for exactly 1,500ms and never
   tracks afterward.
5. Resolution deals positive moderate damage only inside that circle.
6. Tarnished lasts 4,000ms, applies 0.70 movement and 0.75 attack-speed
   multipliers, and cannot stack.
7. The next 9,000ms cooldown begins at resolution, not at cast start.
8. A deterministic combat-arena run through the canonical simulation step records
   at least two fully resolved Verdigris Glamour casts with the exact phase
   cadence (telegraphs at 9,000/19,500ms, resolutions at 10,500/21,000ms), while
   the default normal-game configuration records zero ability casts/events over
   the same duration. This is the hard recurring-ability gate. Real Floor 2
   headless balance validation is intentionally out of scope and deferred to the
   production-enable gate.
9. The combat arena lab (`combat-arena-lab`) provides the faerie-boss selection
   (via the `f2-queen-mab` preset) and shows the same canonical simulation step,
   announcement, circle, damage, debuff, and excessive procedural VFX. The
   announcement banner is wired into the arena scene. **✅ DONE** — arena preset
   and banner wiring verified in PR #1273.
10. No sprite-animation lab is required while cast animation remains
    `not-authored`. Adding animation changes that evidence requirement.
11. Production AI avoids only the same committed circle that is visible to the
    player; it receives no pre-lock player-position prediction.
12. The implementation PR records its issue/PR and deterministic arena evidence
    in the status sidecar, marks the foundation and Mab milestones verified, and
    marks Mab's runtime/telegraph/arena states verified. It must NOT derive Mab as
    production `verified` while the production-enable gate is off, and it must NOT
    promote the other 17 abilities to `ready`; they remain blocked behind the
    separate `floor2-boss-production-enable` gate.

## Test Plan

### Catalog and tracker (this slice)

- `tests/unit/boss-ability-catalog.test.ts` proves strict pack parsing, exactly 18
  boss/family entries, no duplicate/missing coverage, fixed recurring timing,
  lock semantics, announcement formatting, exact Queen values, codex projection,
  derived delivery stages, promotion behavior, runtime art resolver agreement,
  manifest asset presence, truthful committed brief paths, and status report
  completeness.
- `npm run boss-abilities:status` is the human-readable backlog audit.

### Runtime foundation and Queen Mab (this slice)

- Unit tests: phase transitions, cooldown anchor, target lock, cleanup, no
  stacking, exact stat multipliers, announcement/VFX once semantics, geometry
  containment, and AI/render cue-state identity.
- Integration tests: the ability executor in the canonical simulation step,
  including encounter activation/deactivation and recycled entity IDs.
- Deterministic arena evidence: a combat-arena run through the canonical
  simulation step reaches Queen Mab and records at least two resolved casts at
  the expected timestamps without state injection, while the default normal-game
  configuration records zero casts. Real Floor 2 Seed 42 headless balance
  validation is out of scope and deferred to the production-enable gate.
- Deterministic visual tests: the arena renders the locked circle and active
  Tarnished/VFX state; pixel or UI probes verify the cue exists for the complete
  warning window.
- Generated-art manifest validation: every required visual phase has a procedural
  fallback and every generated-art asset is non-blocking for the arena slice.

## Constitutional Compliance

| Principle                | Compliance                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Lab-gated development | PR #1243's arena is mandatory for each implemented entry; authored animation additionally requires animation-lab proof                                                                                    |
| 2. Deterministic core    | Timing has no jitter; patterns use explicit cast ordinals or `SeededRandom`                                                                                                                               |
| 3. Deterministic CI      | Catalog, timing, geometry, state, headless, and pixel/UI probes are deterministic; no LLM judge gates                                                                                                     |
| 4. Layer separation      | Stable content is shared data; simulation remains Phaser-free; engine renders public cue/event state                                                                                                      |
| 9. Observe before done   | For this production-off arena slice, Queen requires canonical arena repeated-cast evidence now; real Floor 2 Seed 42 headless validation remains a required future artifact at the production-enable gate |
| 13. Wired systems        | Any exported runtime system must be present in real visual and headless wiring sites, never lab-only                                                                                                      |

## Docs / index updates required

- This spec is indexed in `.specify/specs/README.md`.
- ADR 0064 is indexed in `docs/knowledge/adr/README.md`.
- Runtime implementation must update `docs/architecture.md` only when an actual
  system exists.
- Every implementation slice must update the status sidecar and write a dated
  handoff.
