# Systems

This directory holds per-system docs. The top-level headings **on this page**
also define the canonical set of **system slugs** used by handoffs and the
generated handoff system-impact index (`docs/knowledge/handoffs/INDEX.md`,
built by `scripts/agent/docs/build-system-index.ts`).

New handoffs declare which systems they touched via a `## Systems touched`
line listing one or more of the slugs below. The generator groups handoffs
under those slugs so planners can look up "what recently happened in system
X" without scanning every handoff.

Keep this list **lumpy, not splitty** — aim for ~25 slugs total. Prefer
folding a new area into an existing bucket over adding a new slug. If a
handoff genuinely spans several systems, list them all; that's the point.

The individual system dossiers (`01-movement-input.md`, `02-combat.md`, …)
remain the deep design docs. This page is only for slug canonicalization.

## ai-pathfinding

Grid pathfinding, flow fields, nav wedges, sidestep and safe-gap steering,
and any AI locomotion/routing beyond raw behavior-tree decisions.

## ai-combat-balance

Win-rate sweeps, weapon sweeps, hill-climb calibration, per-floor balance
gates, and any AI-vs-content difficulty tuning.

## ai-behavior-tree

Behavior tree providers, threat priority, perception, opportunistic actions,
harvesting/pickup detours, runner personalities, and other decision logic
above pathfinding.

## sprite-pipeline

Sprite generation, post-processing, resizing/slicing, palette extraction,
background rekey, checkin/approval flow — the mechanical pipeline that
turns a brief into a game-ready sprite.

## sprite-workflow

Sprite sidecar, gallery, worker, brief authoring, queueing, reload/recovery,
and the operator-facing workflow around the pipeline.

## mapgen

Dungeon generation, room/cave layout, reachability, per-floor configuration,
set-piece rooms, shops, welcome rooms, boss dens (structural), and seed-level
concerns.

## quests

Quest chains, waypoints/arrows, welcome-sign wayfinding, NPC meet quests,
materials harvesting, achievements, and other objective-driven content.

## hud-ux

HUD layout, minimap, on-screen indicators, damage numbers, health bars, and
in-game readability (text crispness, HiDPI).

## mobile-ux

Touch controls and mobile-specific UI/UX (input, layout, safe areas).

## lighting

Per-floor ambient lighting, light-field review, dynamic light granularity,
and any illumination system separate from FOV.

## inventory

Inventory UI, gear/items, gold coins, XP and progression, drops/loot
gating, and item pickup mechanics.

## vfx

Visual effects: gore, corpse explosions, spawn VFX, spell-cast VFX, hit
throttling, and the effects pipeline.

## weapons

Weapon behavior, weapons lab, abilities/spells, ranged/melee tuning, and
weapon equipping.

## enemies

Enemy definitions, mob variants, spawners, spawn distribution, non-LLM
sprite workflow speedups tied to mobs, family AI, and mob-level tuning
below the behavior-tree layer.

## boss-rooms

Boss encounters, boss dens, post-boss stairs, and boss-triggered floor
transitions.

## azure-infra

Azure resources: env provisioning, Foundry, OpenAI provider, sidecar
deployment, live E2E validation, and cloud infrastructure.

## ci-policy

CI gates, verify-fast/verify, review harness/ledger, PR shepherd, apple
calibration policy, complexity policy, workflow deflake, guard telemetry,
and anti-shortcut rules.

## agent-memory

Agent-memory MCP, memory JSONL, memory-systems handoffs, and durable-fact
capture for future sessions.

## worktree-server

The multi-session worktree server, localhost URL routing, and worktree
lifecycle.

## devtools

Devtools UI, prop lab, misc lab canvases, and internal-only development
tooling.

## agent-personas

Persona routing matrix, Producer, Shepherd, Reviewer, and other named
agent roles.

## mcp-tooling

MCP servers and skills tooling (excluding agent-memory MCP, which lives
under `agent-memory`).

## docs-tooling

Docs automation scripts (`scripts/agent/docs/*`), ADR consistency, handoff
promotion/archival, template edits, and this system-impact index itself.
