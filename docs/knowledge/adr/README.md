# Architecture Decision Records (ADR) Index

This directory holds Crawler's Architecture Decision Records — short documents
capturing a single **durable architectural decision**, its context, and its
consequences. New decisions that affect **2+ systems** require an ADR (see the
constitution and `.github/copilot-instructions.md`).

- **Template:** `docs/knowledge/adr/TEMPLATE.md`
- **Count:** 150 ADR files — 107 numbered (0001–0072, with number reuse and gaps in this index — see below) + 43 date-prefixed
- **Status convention:** `## Status` heading with one of
  `Proposed | Accepted | Deprecated | Superseded by NNNN`

### What belongs here vs. elsewhere

- **ADR** — one durable cross-system decision and its rationale.
- **Spec** (`.specify/specs/`) — the living current-state contract for a system.
- **Policy / constitution / instructions** — the live normative rule.
- **Handoff** — implementation notes, postmortems, and one-off cleanup history.

Some older ADRs predate this sharper split. They are retained as historical
provenance, but they are **not** the template for new ADRs.

### Canonical homes after the 2026-07-08 cleanup

| Topic                                  | Canonical current-state home                                                                      | ADRs retained mainly for rationale / history                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Review-harness thresholds              | `docs/agent-os/policies/review-harness-policy.md` + `docs/agent-os/policies/complexity-policy.md` | `0036`, `0051`                                                 |
| CI / verify / scoped heavy gates       | `docs/agent-os/policies/ci-policy.md`                                                             | `0035`                                                         |
| Wired-systems rule                     | `.specify/memory/constitution.md` + `AGENTS.md`                                                   | `0039`                                                         |
| Sprite workflow and sidecar operations | `.specify/specs/sprite-generation-pipeline.md`                                                    | `0003`, `0017`, `0018`, `0023`, `0024`, `0025`, `0037`, `0041` |
| Spawner arena feature family           | `.specify/specs/spawner-battle-arena.md`                                                          | `0044`, `0045`, `0046`, `0049`, `0050`                         |
| Floor 2 systemic contract              | `.specify/specs/floor2-family-territories.md`                                                     | `0040`                                                         |
| Size / weight / physics contract       | `.specify/specs/entity-physics.md`                                                                | `0044-explicit-size-weight-components`                         |

### Grandfathered historical ADRs

These remain in the archive for provenance but should not be copied as new ADR
style:

- [`0014-pr150-post-merge-review-followups.md`](0014-pr150-post-merge-review-followups.md) —
  one-off cleanup scope; future equivalents belong in handoffs or PR notes.
- Tactical operational / instrumentation deltas such as
  [`0041-raise-queue-visibility-timeout-default.md`](0041-raise-queue-visibility-timeout-default.md)
  and [`0048-opt-in-weapon-telemetry.md`](0048-opt-in-weapon-telemetry.md).
- Date-prefixed render/data hookup ADRs, which are kept because renumbering old
  references would be noisier than retaining the historical record.

> This index is generated/maintained by hand. When you add an ADR, add a row to
> the [by-number table](#all-adrs-by-number) and a line to the relevant
> [thematic group](#thematic-index).

---

## Numbering & identity policy

**The filename slug (`NNNN-slug`) is the canonical identifier — not the number
alone.** Several numbers were assigned more than once because parallel agent
sessions each grabbed "the next number" independently. We deliberately **do not
renumber** historical ADRs: their numbers are referenced by handoffs, other
ADRs, commit messages, and code comments, so renumbering would silently break
hundreds of inbound references.

- **`0005`** was an intentional numbering gap, now filled by [Parameterized Floor Configuration System](0005-parameterized-floor-configuration.md).
- **Reused numbers:** `0007` ×2, `0009` ×2, `0017` ×3, `0018` ×5, `0023` ×4,
  `0024` ×3, `0025` ×4, `0026` ×2. The slug disambiguates each.

### Adding a new ADR

1. Copy `TEMPLATE.md` to `NNNN-your-slug.md`, where `NNNN` is **the next unused
   number** (currently **0065**).
2. Fill in `## Status`, `## Date`, `## Estimated Complexity`, `## Context`,
   `## Decision`, `## Consequences`.
3. Always **link by slug**, never by bare number, so collisions stay
   unambiguous.
4. Keep backtick-quoted repo paths accurate — `npm run docs:check` verifies that
   every path an ADR mentions still exists.

---

## Thematic index

### Architecture & core foundations

- [ECS Architecture with bitecs](0001-ecs-architecture.md) — entity-component-system substrate.
- [Lab-Gated Development](0002-lab-gated-development.md) — no system ships without a lab.
- [Spatial Units Architecture (Pixels vs Feet)](0007-spatial-units-architecture.md) — the original units split; superseded by ADR 0023.
- [Feet as the single internal spatial unit](0023-feet-as-single-internal-spatial-unit.md) — sim is feet-only; pixels live in `src/engine`.

### Combat & damage

- [Guard AI / contact damage against death-linger corpses](0017-dead-enemy-corpse-collision-guard.md)
- [Wire secondary stats (crit/dodge) into the damage path](0018-secondary-stats-into-combat.md) — superseded by the primary-stat overhaul (see Stats, mana & progression below).
- [Line-of-sight melee hits & AI loot-reachability gating](0023-line-of-sight-melee-and-loot-reachability.md)
- [Explode corpses into sprite shards when hit during death-linger](0027-corpse-explosion-on-hit.md)

### Weapons & projectiles

- [Projectile max-range despawn rules](0009-projectile-max-range-despawn.md)
- [Line-of-sight gate for weapon auto-targeting](0018-weapon-line-of-sight-targeting.md)
- [Fireball spell targeting (any enemy, cluster-preferring)](0018-fireball-targeting.md)
- [Projectile target-leading & quest-progress stall watchdog](0020-projectile-leading-and-quest-progress-watchdog.md)
- [Versioned frozen Floor 2 equipment instances](0065-versioned-frozen-floor2-equipment-instances.md) — one generated-equipment registry, frozen per-instance `ActiveWeaponSnapshotV1`, and 10 cross-system decisions (DEC-001..DEC-010).

### Stats, mana & progression

- [Wisdom → Mana pool (`manaSystem`) + boss-reward spell hardening](0019-wisdom-mana-pool.md) — superseded; mana removed entirely by the primary-stat overhaul below.
- [Primary-stat system overhaul — EffectiveStats unification, typed damage scaling, encumbrance, and full mana removal](2026-07-16-primary-stat-system-overhaul.md) — supersedes `0018`, `0019`, and `2026-07-10-shared-stat-allocation-and-runtime-derivations.md`.
- [Versioned frozen Floor 2 equipment instances](0065-versioned-frozen-floor2-equipment-instances.md) — rarity budget, enhancement bounds, and the 1.7×–2.3× five-level DPS growth gate (Principle 9).

### Enemy AI, spawning & behavior

- [Extract pure BT exploration decision kernels (C1–C4)](0022-bt-exploration-pure-kernels.md)
- [Behavior tree — build vs. buy (hand-roll for determinism)](0043-behavior-tree-build-vs-buy.md)
- [Baby slime spawn animation (size + pop-out) and swing-immunity](0026-baby-slime-spawn-animation-and-swing-immunity.md)
- [Floor 1 spawn density via a director engagement budget](0024-floor1-spawn-density-engagement-budget.md)
- [Generic Spawner mob-type](0025-spawner-mob-type.md)
- [Data-driven boss ability catalog and separate delivery evidence](0064-data-driven-boss-ability-catalog.md) — validates all 18 Floor 2 designs while keeping volatile status out of the game bundle.

### Floors, rooms & map generation

- [Run bootstrap pattern with modal-paused game flow](0008-floor1-run-bootstrap-modal-pattern.md)
- [Floor 1 boss/stair room architecture](0009-floor1-boss-stair-room-architecture.md)
- [Flexible door-lock conditions with optional relock](0010-door-lock-conditions.md)
- [Multi-safe-room support & NPC quest-callback pattern](0012-multi-safe-room-and-npc-quest-callback-pattern.md)
- [Safe-room runtime system](0013-safe-room-runtime-system.md)
- [Floor 1 room-reachability guarantee & gate-stall fast-fail](0021-floor1-room-reachability-and-gate-stall-fastfail.md)
- [Generic special-room perimeter sealing with door-conversion](0023-generic-special-room-sealing.md)
- [Set-piece themed rooms](0024-set-piece-themed-rooms.md)
- [Set-piece map-gen integration, NPC placement & sprite layering](0046-set-piece-mapgen-integration-npc-placement-layering.md) — resolves 0024's deferred map-gen wiring; adds `npcs[]`, core stamping unit, depth-straddling layering, and auto objective-anchor follow.
- [Door-pointing welcome-sign wayfinding](0026-welcome-sign-wayfinding.md)
- [Parameterized floor configuration system](0005-parameterized-floor-configuration.md) — floor1→floor params via floor-registry; enables multi-floor progression.
- [Floor 2 family-territory & relationship architecture](0040-floor2-family-territory-and-relationship-architecture.md) — open cave system of feuding mob families, per-family player relationships, and a two-shape (sole-ally / total-war) win condition.
- [Durable player-hit signal for ally-defend retaliation](0042-durable-player-hit-signal-for-ally-defend.md) — a durable `world.lastPlayerHit` set at the core `applyDamage` choke point (survives the frame-end VFX drain) plus projectile `Owner` threading, so ally-defend fires in the real game and retaliates against the shooter.
- [Decouple a door's logical-open latch from its physical tile state](0055-door-logical-latch-vs-physical-tile-decouple.md) — renames `doorState.isOpen`→`logicalOpen` (intended-open latch) and adds a derived, stored `effectiveOpen` (physical tile truth), so a safe-room force-close only closes the tile and a shared safe/boss connector door reopens when the seal lifts instead of permanently sealing.
- [Floor 2 settlement progression contract](0059-floor2-settlement-progression-contract.md) — deterministic two-phase introduction (settlement discovery then Broker introduction) shared by quest waypoints, AI routing, and the Families HUD activation gate.
- [Floor 3 — Companion League (commander / auto-battler floor)](0071-floor3-companion-league.md) — inverts combat via the existing `Invincible` tag (player + handlers undamageable), generalizes Floor 2 ally AI into a team-tagged Companion roster, defines a species = affinity × fighting-style model (styles as reusable AI personas seeding `AI_TYPE`), two-track progression (persistent player level/gear vs floor-scoped creature XP), a cross-floor kept-companion slot, party-lock recruiting, simultaneous-wipe lose, and seeded 6-gym + Final Four win.
- [Floor 4 — The Main Event (timed survival arena floor)](0090-floor4-arena.md) — the first non-exploration floor: a dedicated arena clock running continuously through waves and bosses (additive to `world.elapsedMs`), a single `arenaDirectorSystem` phase authority, bounded overtime as the boss failure path, precomputed immutable wave manifests with capped spawn debt, a graded append-only Headliner draw keyed by act slot, isolated per-purpose RNG streams making per-visit shop stock path-independent, and a transactional safe-room hand-off.
- [Floor 4 Slice 2 — Arena Director Rehearsal](0091-floor4-slice2-arena-director-rehearsal.md) — implements the first runtime phase authority as an empty broadcast rehearsal: real-pipeline `arenaDirectorSystem` wiring, exact arena-clock marks, deterministic timeline RunStats, and temporary auto-advanced intermissions until the Green Room transaction slice lands.

### Quests & NPCs

- [Data-driven quest system and quest tracker](0011-data-driven-quest-system.md)
- [Floor 1 drops-unlock & quest-giver room separation](0015-floor1-drops-unlock-and-questgiver-room-separation.md)
- [Floor 1 quest-chain re-sequencing](0016-floor1-quest-chain-resequencing.md)

### Drops & loot

- [Drops system architecture](0006-drops-system-architecture.md)

### Sprites & art-generation pipeline

- Current behavior is canonical in [`.specify/specs/sprite-generation-pipeline.md`](../../../.specify/specs/sprite-generation-pipeline.md); the ADRs below are the decision history.
- [Sprite generation pipeline](0003-sprite-generation-pipeline.md)
- [Azure-backed sprite workflow-state persistence](0017-azure-workflow-state-persistence.md)
- [Sidecar owns an in-process sprite-generation worker](0018-sidecar-owned-sprite-worker.md)
- [Unify sprite-sheet slicing on the content-aware path](0018-unify-sheet-slicing-content-aware.md)
- [Re-runnable PostProcess & Judge over stored sheets](0023-rerunnable-postprocess-judge.md)
- [Generate stores the raw sheet only (Option B)](0024-generate-stores-raw-sheet-only.md)
- [Devtools sprite workflow — 7-stage restructure](0025-workflow-7-stage-restructure.md)
- [Multi-variant generated sprites](0028-generated-sprite-variants.md) — identity, selection, approval, and check-in.
- [Migrate content generation to Azure AI Foundry](0033-azure-foundry-content-generation.md) — **Superseded by ADR 0072.**
- [Retire Foundry — Standardize Asset Pipeline on Azure OpenAI](0072-retire-foundry-standardize-azure-openai.md) — removes the dead `foundry` provider backend; `SUPPORTED_BACKENDS` is now `['azure-openai', 'local-a1111']`.
- [Sprite worker poison-message handling](0037-sprite-worker-poison-message-handling.md) — bounded failures (dequeueCount cap), permanent-drop, and comment-once to stop runaway retry loops and issue-comment spam.
- [Asset-request briefs accept rich multi-sentence text](0038-asset-request-multi-sentence-brief.md) — relax the issue/marker brief contract so multi-sentence briefs enqueue.
- [Raise Azure Storage Queue default visibility timeout to 900s](0041-raise-queue-visibility-timeout-default.md) — a 16-cell gpt-image-1 sheet outruns the old 300s window; 900s stops false "message does not exist" acks and needless regeneration.
- [Shared Azure Resource Cache](0065-shared-azure-resource-cache.md) — one sidecar-authoritative, content-addressable, LRU-bounded cache replaces the bespoke sheet-only cache and four+ unbounded per-extension caches; cache-first blob reads and an offline hard-gate.
- [Stale-while-revalidate listings for the shared Azure resource cache](2026-07-22-sprite-list-cache-swr.md) — `list()` now serves an epoch-fresh warmed snapshot instantly online, with a deduped background refresh/purge, closing the one read path ADR 0065 had left blocking on a live Azure round-trip.

### Rendering, HUD & VFX

- [Boss health bar as a scaled HUD component](0017-boss-health-bar-hud-component.md)
- [HiDPI supersampling render scale for crisp text](0025-hidpi-supersampling-render-scale.md)
- [Generic VFX effects pipeline](0025-vfx-effects-pipeline.md)
- [Reward-opening audio as a reusable, deterministic cue layer](0071-reward-opening-audio-cues.md) — the first `AudioCueEngine`-based procedural synth cue layer.
- [Combat/loot audio cues as a second reuse of the reward-opening cue pattern](2026-08-23-combat-loot-audio-cues.md) — weapon/spell/ability/damage/pickup SFX sourced from the existing `combatEvents`/`abilityActivations`/`vfxEvents` queues, no new core plumbing.

### Process, CI & telemetry

- [Chronicle as Agent-OS telemetry backend](0004-chronicle-telemetry.md)
- [Looping automation workflows](0007-automation-loops.md)
- [PR150 post-merge review follow-up scope](0014-pr150-post-merge-review-followups.md) — grandfathered historical cleanup record; not precedent for new ADRs.
- [Deterministic orphaned-system wiring guard](0039-orphaned-system-wiring-guard.md) — every exported `*System` must be wired into a real pipeline or explicitly allowlisted.
- [Asset-request CI worker bypass for Constitutional §3](0043-ci-asset-request-worker-bypass.md) — a gated bypass flag lets the asset-request worker run its Azure paths outside CI without violating §3 determinism.
- [Raise the review-harness code-review floor to 3🍎](0036-raise-code-review-floor.md) — code-review loop required at 3🍎+ (plan review then also raised to 3🍎).
- [Replace dual-plan synthesis with an adversarial plan review](0051-adversarial-plan-review-fold.md) — retires the 4–5🍎 second-author stage (2/17 decisive-fork rate) for one red-teaming reviewer; adds a `plan_divergence` instrumentation enum at ≥3🍎.
- [Slicer cuts only at real gutters — data-driven grid salvage](0052-slicer-never-cut-through-art.md) — the slicer never invents a cut; grid/count are read from the sheet (brief is a soft anchor), runt edge cells are trimmed, and the generation count gate is relaxed. Reverses the 2026-07-07 force-count reconciliation that chopped art on the right edge.
- [GitHub-first broad-sweep execution and investigation-session process boundary](0056-github-first-broad-sweep-and-investigation-session-policy.md) — broad sweeps (>10 runs) default to GitHub workflow dispatch; investigation sessions stay process-light unless shipping merge-intent code.
- [GitHub-native CI recovery ownership](0058-github-native-ci-recovery-ownership.md) — trusted, deduplicated CI recovery and shepherd ownership.
- [Repository-managed speculative merge train](0060-repository-managed-speculative-merge-train.md) — validates two cumulative candidates and advances `main` only to the exact tested SHA.

---

## All ADRs by number

Rows sharing a number are distinct decisions (see the [identity policy](#numbering--identity-policy)).

| #    | Title                                                                                                                                              | Status                   | Date       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------- |
| 0001 | [ECS Architecture with bitecs](0001-ecs-architecture.md)                                                                                           | Accepted                 | 2024-12-01 |
| 0002 | [Lab-Gated Development](0002-lab-gated-development.md)                                                                                             | Accepted                 | 2024-12-01 |
| 0003 | [Sprite Generation Pipeline](0003-sprite-generation-pipeline.md)                                                                                   | Accepted                 | 2026-06-04 |
| 0004 | [Chronicle as Agent-OS Telemetry Backend](0004-chronicle-telemetry.md)                                                                             | Accepted                 | 2026-06-05 |
| 0005 | [Parameterized Floor Configuration System](0005-parameterized-floor-configuration.md)                                                              | Accepted                 | 2026-06-26 |
| 0006 | [Drops System Architecture](0006-drops-system-architecture.md)                                                                                     | Accepted                 | 2026-06-05 |
| 0007 | [Looping Automation Workflows](0007-automation-loops.md)                                                                                           | Accepted                 | 2026-06-07 |
| 0007 | [Spatial Units Architecture (Pixels vs Feet)](0007-spatial-units-architecture.md)                                                                  | Superseded by 0023       | 2026-06-08 |
| 0008 | [Run Bootstrap Pattern with Modal-Paused Game Flow](0008-floor1-run-bootstrap-modal-pattern.md)                                                    | Accepted                 | 2026-06-08 |
| 0009 | [Floor 1 Boss/Stair Room Architecture](0009-floor1-boss-stair-room-architecture.md)                                                                | Accepted                 | 2026-06-09 |
| 0009 | [Projectile Max Range Despawn Rules](0009-projectile-max-range-despawn.md)                                                                         | Accepted                 | 2026-06-09 |
| 0010 | [Flexible Door Lock Conditions with Optional Relock](0010-door-lock-conditions.md)                                                                 | Accepted                 | 2026-06-09 |
| 0011 | [Data-driven quest system and quest tracker](0011-data-driven-quest-system.md)                                                                     | Accepted                 | 2026-06-12 |
| 0012 | [Multi-Safe-Room Support and NPC Quest Callback Pattern](0012-multi-safe-room-and-npc-quest-callback-pattern.md)                                   | Deprecated               | 2026-06-11 |
| 0013 | [Safe Room Runtime System](0013-safe-room-runtime-system.md)                                                                                       | Accepted                 | 2026-06-14 |
| 0014 | [PR150 Post-Merge Review Follow-up Scope](0014-pr150-post-merge-review-followups.md)                                                               | Deprecated               | 2026-06-19 |
| 0015 | [Floor 1 Drops Unlock & Quest-Giver Room Separation](0015-floor1-drops-unlock-and-questgiver-room-separation.md)                                   | Accepted                 | 2026-06-21 |
| 0016 | [Floor 1 Quest-Chain Re-Sequencing](0016-floor1-quest-chain-resequencing.md)                                                                       | Accepted                 | 2026-06-21 |
| 0017 | [Azure-backed Sprite Workflow-State Persistence](0017-azure-workflow-state-persistence.md)                                                         | Accepted                 | 2026-06-24 |
| 0017 | [Boss Health Bar as a Scaled HUD Component](0017-boss-health-bar-hud-component.md)                                                                 | Accepted                 | 2026-06-25 |
| 0017 | [Guard Enemy AI & Contact Damage Against Death-Linger Corpses](0017-dead-enemy-corpse-collision-guard.md)                                          | Accepted                 | 2026-06-25 |
| 0018 | [Fireball Spell Targeting (Any Enemy, Cluster-Preferring)](0018-fireball-targeting.md)                                                             | Accepted                 | 2026-06-25 |
| 0018 | [Wire Secondary Stats (crit/dodge) Into the Combat Damage Path](0018-secondary-stats-into-combat.md)                                               | Superseded by 2026-07-16 | 2026-06-25 |
| 0018 | [Sidecar Owns an In-Process Sprite-Generation Worker](0018-sidecar-owned-sprite-worker.md)                                                         | Accepted                 | 2026-06-25 |
| 0018 | [Unify Sprite Sheet Slicing on the Content-Aware Path](0018-unify-sheet-slicing-content-aware.md)                                                  | Accepted                 | 2026-06-25 |
| 0018 | [Line-of-Sight Gate for Weapon Auto-Targeting](0018-weapon-line-of-sight-targeting.md)                                                             | Accepted                 | 2026-06-25 |
| 0019 | [Wisdom → Mana Pool (`manaSystem`) + Boss Spell-Reward Hardening](0019-wisdom-mana-pool.md)                                                        | Superseded by 2026-07-16 | 2026-06-25 |
| 0020 | [Projectile Target-Leading & Quest-Progress Stall Watchdog](0020-projectile-leading-and-quest-progress-watchdog.md)                                | Accepted                 | 2026-06-25 |
| 0021 | [Floor 1 Room-Reachability Guarantee & Headless Gate-Stall Fast-Fail](0021-floor1-room-reachability-and-gate-stall-fastfail.md)                    | Accepted                 | 2026-06-26 |
| 0022 | [Extract Pure BT Exploration Decision Kernels (C1–C4)](0022-bt-exploration-pure-kernels.md)                                                        | Accepted                 | 2026-06-26 |
| 0023 | [Feet as the Single Internal Spatial Unit](0023-feet-as-single-internal-spatial-unit.md)                                                           | Accepted                 | 2026-06-26 |
| 0023 | [Generic Special-Room Perimeter Sealing with Door-Conversion](0023-generic-special-room-sealing.md)                                                | Accepted                 | 2026-06-26 |
| 0023 | [Line-of-Sight Melee Hits and AI Loot-Reachability Gating](0023-line-of-sight-melee-and-loot-reachability.md)                                      | Accepted                 | 2026-06-27 |
| 0023 | [Re-runnable PostProcess & Judge Over Stored Sprite Sheets](0023-rerunnable-postprocess-judge.md)                                                  | Accepted                 | 2026-06-26 |
| 0024 | [Floor 1 Spawn Density via a Director Engagement Budget](0024-floor1-spawn-density-engagement-budget.md)                                           | Accepted                 | 2026-06-25 |
| 0024 | [Generate Stores the Raw Sheet Only (Option B)](0024-generate-stores-raw-sheet-only.md)                                                            | Accepted                 | 2026-06-26 |
| 0024 | [Set Piece Themed Rooms](0024-set-piece-themed-rooms.md)                                                                                           | Accepted                 | 2026-06-25 |
| 0025 | [HiDPI Supersampling Render Scale for Crisp Text](0025-hidpi-supersampling-render-scale.md)                                                        | Accepted                 | 2026-06-26 |
| 0025 | [Generic Spawner Mob-Type](0025-spawner-mob-type.md)                                                                                               | Accepted                 | 2026-06-27 |
| 0025 | [Generic VFX Effects Pipeline](0025-vfx-effects-pipeline.md)                                                                                       | Accepted                 | 2026-06-26 |
| 0025 | [Devtools Sprite Workflow — 7-Stage Restructure](0025-workflow-7-stage-restructure.md)                                                             | Accepted                 | 2026-06-26 |
| 0026 | [Baby Slime Spawn Animation and Swing-Immunity](0026-baby-slime-spawn-animation-and-swing-immunity.md)                                             | Accepted                 | 2026-06-26 |
| 0026 | [Door-Pointing Welcome-Sign Wayfinding](0026-welcome-sign-wayfinding.md)                                                                           | Accepted                 | 2026-06-27 |
| 0027 | [Explode Corpses Into Sprite Shards When Hit During Death-Linger](0027-corpse-explosion-on-hit.md)                                                 | Accepted                 | 2026-06-27 |
| 0028 | [Multi-Variant Generated Sprites](0028-generated-sprite-variants.md)                                                                               | Accepted                 | 2026-06-26 |
| 0029 | [Size variants reshape the sheet grid (fixed canvas)](0029-size-variant-grid-reshape.md)                                                           | Accepted                 | 2026-06-27 |
| 0030 | [Materials Harvesting System](0030-materials-harvesting-system.md)                                                                                 | Accepted                 | 2026-07-10 |
| 0031 | [Safe-room Achievements panel with reveal-only rewards](0031-achievements-safe-room-panel.md)                                                      | Accepted                 | 2026-06-28 |
| 0031 | [Quest waypoints + HUD direction arrows for Floor 1 findability](0031-quest-waypoints-direction-arrows.md)                                         | Accepted                 | 2026-06-28 |
| 0032 | [AI Runner gathers harvestables](0032-ai-runner-harvesting.md)                                                                                     | Accepted                 | 2026-06-28 |
| 0033 | [Migrate Content Generation to Azure AI Foundry](0033-azure-foundry-content-generation.md)                                                         | Proposed                 | 2026-06-29 |
| 0033 | [Extract shared math/grid/room-hop utilities and dedupe constants](0033-refactor-shared-utilities.md)                                              | Accepted                 | 2026-06-29 |
| 0034 | [Config-Driven Sprite Wiring](0034-config-driven-sprite-wiring.md)                                                                                 | Accepted                 | 2026-06-30 |
| 0034 | [Quarter-tile FOV/fog-of-war resolution](0034-quarter-tile-fov-resolution.md)                                                                      | Accepted                 | 2026-06-30 |
| 0034 | [Spawner Spawn Telegraph Feedback](0034-spawner-spawn-telegraph-feedback.md)                                                                       | Accepted                 | 2026-06-30 |
| 0035 | [Scope the Headless Gate, De-duplicate Local Verify, and Title-Only Commit-Lint](0035-scope-headless-gate-and-dedup-verify.md)                     | Accepted                 | 2026-07-02 |
| 0036 | [Raise the Review-Harness Code-Review Floor to 3🍎](0036-raise-code-review-floor.md)                                                               | Accepted                 | 2026-07-02 |
| 0036 | [Wire spawnerSystem into the real pipelines + placeholder tint](0036-wire-spawner-system-real-pipelines.md)                                        | Accepted                 | 2026-07-02 |
| 0037 | [Sprite Worker Poison-Message Handling (bounded failures, comment-once)](0037-sprite-worker-poison-message-handling.md)                            | Accepted                 | 2026-07-02 |
| 0038 | [Asset-Request Briefs Accept Rich Multi-Sentence Text](0038-asset-request-multi-sentence-brief.md)                                                 | Accepted                 | 2026-07-01 |
| 0039 | [Deterministic Orphaned-System Wiring Guard](0039-orphaned-system-wiring-guard.md)                                                                 | Accepted                 | 2026-07-02 |
| 0040 | [Floor 2 Family-Territory & Relationship Architecture](0040-floor2-family-territory-and-relationship-architecture.md)                              | Proposed                 | 2026-07-01 |
| 0041 | [Raise Azure Storage Queue Default Visibility Timeout to 900s](0041-raise-queue-visibility-timeout-default.md)                                     | Accepted                 | 2026-07-02 |
| 0042 | [Durable Player-Hit Signal for Ally-Defend Retaliation](0042-durable-player-hit-signal-for-ally-defend.md)                                         | Accepted                 | 2026-07-03 |
| 0043 | [Behavior Tree — Build vs. Buy](0043-behavior-tree-build-vs-buy.md)                                                                                | Accepted                 | 2026-06-26 |
| 0043 | [Asset-request CI Worker Bypass for Constitutional §3](0043-ci-asset-request-worker-bypass.md)                                                     | Accepted                 | 2026-07-03 |
| 0043 | [Floor 2 Scenario Definition & Governor Sweep Wiring](0043-floor2-scenario-definition-and-governor-sweep-wiring.md)                                | Accepted                 | 2026-07-03 |
| 0044 | [Explicit Size and Weight components for canonical physics](0044-explicit-size-weight-components.md)                                               | Proposed                 | 2026-07-04 |
| 0044 | [Floor 2 visual runability wiring and honest Governor gate scope](0044-floor2-visual-runability-and-honest-governor-gate-scope.md)                 | Accepted                 | 2026-07-05 |
| 0044 | [Spawner Battle Arena](0044-spawner-battle-arena.md)                                                                                               | Accepted                 | 2026-07-04 |
| 0045 | [AI Arena Lock-in Priority](0045-ai-arena-lockin-priority.md)                                                                                      | Accepted                 | 2026-07-04 |
| 0046 | [Spawner-Arena "Ever Armed" Latch & `resolvedArmed` Telemetry](0046-spawner-arena-armed-telemetry.md)                                              | Accepted                 | 2026-07-05 |
| 0046 | [Floor 2 Ambient Director with Territory-Weighted Trash Selection](0046-floor2-ambient-director-territory-weights.md)                              | Accepted                 | 2026-07-06 |
| 0046 | [Set-Piece Map-Gen Integration, NPC Placement & Sprite Layering](0046-set-piece-mapgen-integration-npc-placement-layering.md)                      | Accepted                 | 2026-07-06 |
| 0047 | [Spatial-Scoping Performance Optimizations](0047-spatial-scoping-performance.md)                                                                   | Accepted                 | 2026-07-06 |
| 0048 | [Opt-in Per-Run Weapon Telemetry (accuracy + multi-hit)](0048-opt-in-weapon-telemetry.md)                                                          | Accepted                 | 2026-07-06 |
| 0049 | [Floor 1 is Spawner-Free by Empty Spawn Table](0049-floor1-spawner-free-by-config.md)                                                              | Accepted                 | 2026-07-07 |
| 0050 | [Dynamic Barrier Primitive](0050-dynamic-barrier-primitive.md)                                                                                     | Accepted                 | 2026-07-04 |
| 0051 | [Replace Dual-Plan Synthesis with an Adversarial Plan Review](0051-adversarial-plan-review-fold.md)                                                | Accepted                 | 2026-07-08 |
| 0052 | [Slicer Cuts Only at Real Gutters — Data-Driven Grid Salvage](0052-slicer-never-cut-through-art.md)                                                | Accepted                 | 2026-07-08 |
| 0053 | [Floor-agnostic spawn-zone union and enemy-art placeholder auditing](0053-floor-spawn-zone-union-and-enemy-placeholder-audit.md)                   | Accepted                 | 2026-07-08 |
| 0054 | [Floor 2 Settlement NPC Appearance-Key and Dialogue-Override Threading](0054-floor2-settlement-npc-appearance-and-dialogue-threading.md)           | Accepted                 | 2026-07-09 |
| 0054 | [Knip dead-code gate and entry roots](0054-knip-dead-code-gate-and-entry-roots.md)                                                                 | Accepted                 | 2026-07-09 |
| 0055 | [Decouple a Door's Logical-Open Latch from Its Physical Tile State](0055-door-logical-latch-vs-physical-tile-decouple.md)                          | Accepted                 | 2026-07-10 |
| 0055 | [Floor 2 Progression Gates: Feature Unlocks, Reputation, Hidden Quests](0055-floor2-progression-gates.md)                                          | Accepted                 | 2026-07-10 |
| 0056 | [GitHub-First Broad-Sweep Execution and Investigation Session Process Boundary](0056-github-first-broad-sweep-and-investigation-session-policy.md) | Accepted                 | 2026-07-10 |
| 0059 | [Floor 2 Settlement Progression Contract](0059-floor2-settlement-progression-contract.md)                                                          | Accepted                 | 2026-07-11 |
| 0060 | [Repository-Managed Speculative Merge Train](0060-repository-managed-speculative-merge-train.md)                                                   | Accepted                 | 2026-07-11 |
| 0061 | [Game Intro Screen — Player Identity Before Run Start](0061-game-intro-screen-player-identity.md)                                                  | Accepted                 | 2026-07-13 |
| 0062 | [Merge-Train Ruleset App Bypass (Fixing GH006 Under Classic Protection)](0062-merge-train-ruleset-app-bypass.md)                                   | Accepted                 | 2026-07-15 |
| 0062 | [Unlock-aware objective route planning](0062-unlock-aware-objective-route-planning.md)                                                             | Accepted                 | 2026-07-15 |
| 0063 | [Merge-Train Real GitHub Squash-Merge Promotion (MERGED Completion Semantics)](0063-merge-train-real-squash-merge-promotion.md)                    | Accepted                 | 2026-07-15 |
| 0064 | [In-Process Floor Transition Carryover](0064-in-process-floor-transition-carryover.md)                                                             | Accepted                 | 2026-07-17 |
| 0064 | [Data-Driven Boss Ability Catalog and Separate Delivery Evidence](0064-data-driven-boss-ability-catalog.md)                                        | Accepted                 | 2026-07-17 |
| 0065 | [Versioned Frozen Floor 2 Equipment Instances](0065-versioned-frozen-floor2-equipment-instances.md)                                                | Accepted                 | 2026-07-17 |
| 0066 | [Unique Equipment Schema, Acquisition, and Duplicate Policy](0066-unique-equipment-schema-and-acquisition.md)                                      | Accepted                 | 2026-07-19 |
| 0068 | [Generator-Only Floor 2 Equipment Catalog Boundary](0068-generator-only-floor2-equipment-catalog-boundary.md)                                      | Accepted                 | 2026-07-22 |
| 0071 | [Floor 3 — Companion League (commander / auto-battler floor)](0071-floor3-companion-league.md)                                                     | Proposed                 | 2026-07-24 |
| 0072 | [Retire Foundry — Standardize Asset Pipeline on Azure OpenAI](0072-retire-foundry-standardize-azure-openai.md)                                     | Accepted                 | 2026-07-24 |
| 0090 | [Floor 4 — The Main Event (timed survival arena floor)](0090-floor4-arena.md)                                                                      | Proposed                 | 2026-08-22 |
| 0091 | [Floor 4 Slice 2 — Arena Director Rehearsal](0091-floor4-slice2-arena-director-rehearsal.md)                                                       | Accepted                 | 2026-08-24 |
