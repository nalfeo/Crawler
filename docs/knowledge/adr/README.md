# Architecture Decision Records (ADR) Index

This directory holds Crawler's Architecture Decision Records — short documents
capturing a single significant decision, its context, and its consequences. New
decisions that affect **2+ systems** require an ADR (see the constitution and
`.github/copilot-instructions.md`).

- **Template:** `docs/knowledge/adr/TEMPLATE.md`
- **Count:** 45 ADRs (0001–0028, with number reuse — see below)
- **Status convention:** `## Status` heading with one of
  `Proposed | Accepted | Deprecated | Superseded by NNNN`

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
   number** (currently **0029**).
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
- [Spatial Units Architecture (Pixels vs Feet)](0007-spatial-units-architecture.md) — the original units split.
- [Feet as the single internal spatial unit](0023-feet-as-single-internal-spatial-unit.md) — sim is feet-only; pixels live in `src/engine`.

### Combat & damage

- [Guard AI / contact damage against death-linger corpses](0017-dead-enemy-corpse-collision-guard.md)
- [Wire secondary stats (crit/dodge) into the damage path](0018-secondary-stats-into-combat.md)
- [Line-of-sight melee hits & AI loot-reachability gating](0023-line-of-sight-melee-and-loot-reachability.md)
- [Explode corpses into sprite shards when hit during death-linger](0027-corpse-explosion-on-hit.md)

### Weapons & projectiles

- [Projectile max-range despawn rules](0009-projectile-max-range-despawn.md)
- [Line-of-sight gate for weapon auto-targeting](0018-weapon-line-of-sight-targeting.md)
- [Fireball spell targeting (any enemy, cluster-preferring)](0018-fireball-targeting.md)
- [Projectile target-leading & quest-progress stall watchdog](0020-projectile-leading-and-quest-progress-watchdog.md)

### Stats, mana & progression

- [Wisdom → Mana pool (`manaSystem`) + boss-reward spell hardening](0019-wisdom-mana-pool.md)

### Enemy AI, spawning & behavior

- [Extract pure BT exploration decision kernels (C1–C4)](0022-bt-exploration-pure-kernels.md)
- [Baby slime spawn animation (size + pop-out) and swing-immunity](0026-baby-slime-spawn-animation-and-swing-immunity.md)
- [Floor 1 spawn density via a director engagement budget](0024-floor1-spawn-density-engagement-budget.md)
- [Generic Spawner mob-type](0025-spawner-mob-type.md)

### Floors, rooms & map generation

- [Run bootstrap pattern with modal-paused game flow](0008-floor1-run-bootstrap-modal-pattern.md)
- [Floor 1 boss/stair room architecture](0009-floor1-boss-stair-room-architecture.md)
- [Flexible door-lock conditions with optional relock](0010-door-lock-conditions.md)
- [Multi-safe-room support & NPC quest-callback pattern](0012-multi-safe-room-and-npc-quest-callback-pattern.md)
- [Safe-room runtime system](0013-safe-room-runtime-system.md)
- [Floor 1 room-reachability guarantee & gate-stall fast-fail](0021-floor1-room-reachability-and-gate-stall-fastfail.md)
- [Generic special-room perimeter sealing with door-conversion](0023-generic-special-room-sealing.md)
- [Set-piece themed rooms](0024-set-piece-themed-rooms.md)
- [Door-pointing welcome-sign wayfinding](0026-welcome-sign-wayfinding.md)
- [Parameterized floor configuration system](0005-parameterized-floor-configuration.md) — floor1→floor params via floor-registry; enables multi-floor progression.

### Quests & NPCs

- [Data-driven quest system and quest tracker](0011-data-driven-quest-system.md)
- [Floor 1 drops-unlock & quest-giver room separation](0015-floor1-drops-unlock-and-questgiver-room-separation.md)
- [Floor 1 quest-chain re-sequencing](0016-floor1-quest-chain-resequencing.md)

### Drops & loot

- [Drops system architecture](0006-drops-system-architecture.md)

### Sprites & art-generation pipeline

- [Sprite generation pipeline](0003-sprite-generation-pipeline.md)
- [Azure-backed sprite workflow-state persistence](0017-azure-workflow-state-persistence.md)
- [Sidecar owns an in-process sprite-generation worker](0018-sidecar-owned-sprite-worker.md)
- [Unify sprite-sheet slicing on the content-aware path](0018-unify-sheet-slicing-content-aware.md)
- [Re-runnable PostProcess & Judge over stored sheets](0023-rerunnable-postprocess-judge.md)
- [Generate stores the raw sheet only (Option B)](0024-generate-stores-raw-sheet-only.md)
- [Devtools sprite workflow — 7-stage restructure](0025-workflow-7-stage-restructure.md)
- [Multi-variant generated sprites](0028-generated-sprite-variants.md) — identity, selection, approval, and check-in.

### Rendering, HUD & VFX

- [Boss health bar as a scaled HUD component](0017-boss-health-bar-hud-component.md)
- [HiDPI supersampling render scale for crisp text](0025-hidpi-supersampling-render-scale.md)
- [Generic VFX effects pipeline](0025-vfx-effects-pipeline.md)

### Process, CI & telemetry

- [Chronicle as Agent-OS telemetry backend](0004-chronicle-telemetry.md)
- [Looping automation workflows](0007-automation-loops.md)
- [PR150 post-merge review follow-up scope](0014-pr150-post-merge-review-followups.md)

---

## All ADRs by number

Rows sharing a number are distinct decisions (see the [identity policy](#numbering--identity-policy)).

| #    | Title                                                                                                                           | Status   | Date       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| 0001 | [ECS Architecture with bitecs](0001-ecs-architecture.md)                                                                        | Accepted | 2024-12-01 |
| 0002 | [Lab-Gated Development](0002-lab-gated-development.md)                                                                          | Accepted | 2024-12-01 |
| 0003 | [Sprite Generation Pipeline](0003-sprite-generation-pipeline.md)                                                                | Accepted | 2026-06-04 |
| 0004 | [Chronicle as Agent-OS Telemetry Backend](0004-chronicle-telemetry.md)                                                          | Accepted | 2026-06-05 |
| 0005 | [Parameterized Floor Configuration System](0005-parameterized-floor-configuration.md)                                           | Accepted | 2026-06-26 |
| 0006 | [Drops System Architecture](0006-drops-system-architecture.md)                                                                  | Accepted | 2026-06-05 |
| 0007 | [Looping Automation Workflows](0007-automation-loops.md)                                                                        | Accepted | 2026-06-07 |
| 0007 | [Spatial Units Architecture (Pixels vs Feet)](0007-spatial-units-architecture.md)                                               | Accepted | 2026-06-08 |
| 0008 | [Run Bootstrap Pattern with Modal-Paused Game Flow](0008-floor1-run-bootstrap-modal-pattern.md)                                 | Accepted | 2026-06-08 |
| 0009 | [Floor 1 Boss/Stair Room Architecture](0009-floor1-boss-stair-room-architecture.md)                                             | Accepted | 2026-06-09 |
| 0009 | [Projectile Max Range Despawn Rules](0009-projectile-max-range-despawn.md)                                                      | Accepted | 2026-06-09 |
| 0010 | [Flexible Door Lock Conditions with Optional Relock](0010-door-lock-conditions.md)                                              | Accepted | 2026-06-09 |
| 0011 | [Data-driven quest system and quest tracker](0011-data-driven-quest-system.md)                                                  | Accepted | 2026-06-12 |
| 0012 | [Multi-Safe-Room Support and NPC Quest Callback Pattern](0012-multi-safe-room-and-npc-quest-callback-pattern.md)                | Accepted | 2026-06-11 |
| 0013 | [Safe Room Runtime System](0013-safe-room-runtime-system.md)                                                                    | Accepted | 2026-06-14 |
| 0014 | [PR150 Post-Merge Review Follow-up Scope](0014-pr150-post-merge-review-followups.md)                                            | Accepted | 2026-06-19 |
| 0015 | [Floor 1 Drops Unlock & Quest-Giver Room Separation](0015-floor1-drops-unlock-and-questgiver-room-separation.md)                | Accepted | 2026-06-21 |
| 0016 | [Floor 1 Quest-Chain Re-Sequencing](0016-floor1-quest-chain-resequencing.md)                                                    | Accepted | 2026-06-21 |
| 0017 | [Azure-backed Sprite Workflow-State Persistence](0017-azure-workflow-state-persistence.md)                                      | Accepted | 2026-06-24 |
| 0017 | [Boss Health Bar as a Scaled HUD Component](0017-boss-health-bar-hud-component.md)                                              | Accepted | 2026-06-25 |
| 0017 | [Guard Enemy AI & Contact Damage Against Death-Linger Corpses](0017-dead-enemy-corpse-collision-guard.md)                       | Accepted | 2026-06-25 |
| 0018 | [Fireball Spell Targeting (Any Enemy, Cluster-Preferring)](0018-fireball-targeting.md)                                          | Accepted | 2026-06-25 |
| 0018 | [Wire Secondary Stats (crit/dodge) Into the Combat Damage Path](0018-secondary-stats-into-combat.md)                            | Accepted | 2026-06-25 |
| 0018 | [Sidecar Owns an In-Process Sprite-Generation Worker](0018-sidecar-owned-sprite-worker.md)                                      | Accepted | 2026-06-25 |
| 0018 | [Unify Sprite Sheet Slicing on the Content-Aware Path](0018-unify-sheet-slicing-content-aware.md)                               | Accepted | 2026-06-25 |
| 0018 | [Line-of-Sight Gate for Weapon Auto-Targeting](0018-weapon-line-of-sight-targeting.md)                                          | Accepted | 2026-06-25 |
| 0019 | [Wisdom → Mana Pool (`manaSystem`) + Boss Spell-Reward Hardening](0019-wisdom-mana-pool.md)                                     | Accepted | 2026-06-25 |
| 0020 | [Projectile Target-Leading & Quest-Progress Stall Watchdog](0020-projectile-leading-and-quest-progress-watchdog.md)             | Accepted | 2026-06-25 |
| 0021 | [Floor 1 Room-Reachability Guarantee & Headless Gate-Stall Fast-Fail](0021-floor1-room-reachability-and-gate-stall-fastfail.md) | Accepted | 2026-06-26 |
| 0022 | [Extract Pure BT Exploration Decision Kernels (C1–C4)](0022-bt-exploration-pure-kernels.md)                                     | Accepted | 2026-06-26 |
| 0023 | [Feet as the Single Internal Spatial Unit](0023-feet-as-single-internal-spatial-unit.md)                                        | Accepted | 2026-06-26 |
| 0023 | [Generic Special-Room Perimeter Sealing with Door-Conversion](0023-generic-special-room-sealing.md)                             | Accepted | 2026-06-26 |
| 0023 | [Line-of-Sight Melee Hits and AI Loot-Reachability Gating](0023-line-of-sight-melee-and-loot-reachability.md)                   | Accepted | 2026-06-27 |
| 0023 | [Re-runnable PostProcess & Judge Over Stored Sprite Sheets](0023-rerunnable-postprocess-judge.md)                               | Accepted | 2026-06-26 |
| 0024 | [Floor 1 Spawn Density via a Director Engagement Budget](0024-floor1-spawn-density-engagement-budget.md)                        | Accepted | 2026-06-25 |
| 0024 | [Generate Stores the Raw Sheet Only (Option B)](0024-generate-stores-raw-sheet-only.md)                                         | Accepted | 2026-06-26 |
| 0024 | [Set Piece Themed Rooms](0024-set-piece-themed-rooms.md)                                                                        | Accepted | 2026-06-25 |
| 0025 | [HiDPI Supersampling Render Scale for Crisp Text](0025-hidpi-supersampling-render-scale.md)                                     | Accepted | 2026-06-26 |
| 0025 | [Generic Spawner Mob-Type](0025-spawner-mob-type.md)                                                                            | Accepted | 2026-06-27 |
| 0025 | [Generic VFX Effects Pipeline](0025-vfx-effects-pipeline.md)                                                                    | Accepted | 2026-06-26 |
| 0025 | [Devtools Sprite Workflow — 7-Stage Restructure](0025-workflow-7-stage-restructure.md)                                          | Accepted | 2026-06-26 |
| 0026 | [Baby Slime Spawn Animation and Swing-Immunity](0026-baby-slime-spawn-animation-and-swing-immunity.md)                          | Accepted | 2026-06-26 |
| 0026 | [Door-Pointing Welcome-Sign Wayfinding](0026-welcome-sign-wayfinding.md)                                                        | Accepted | 2026-06-27 |
| 0027 | [Explode Corpses Into Sprite Shards When Hit During Death-Linger](0027-corpse-explosion-on-hit.md)                              | Accepted | 2026-06-27 |
| 0028 | [Multi-Variant Generated Sprites](0028-generated-sprite-variants.md)                                                            | Accepted | 2026-06-26 |
