---
title: Architecture and Layers
type: note
permalink: architecture-and-layers
tags: [architecture, layers, ecs]
---

# Architecture and Layers

Crawler uses an Entity-Component-System architecture (bitecs 0.4). Logic is kept
strictly separate from rendering via a bridge pattern so the core stays portable
and deterministic. Layer boundaries are enforced by ESLint.

## Observations

- [layer] src/core — pure ECS game logic; no rendering imports; must not import Phaser #core
- [layer] src/engine — Phaser 4 bridge; rendering only; replaceable #engine
- [layer] src/game — game systems: crafting, loot, floors, AI, combat, progression #game
- [layer] src/labs — dev sandboxes; unrestricted imports; every system needs a lab here #labs
- [layer] src/shared — constants, types, utilities; holds random.ts and constants.ts #shared
- [extra] src/bootstrap and src/devtools exist alongside the five enforced layers #structure
- [rule] Import direction is one-way: core ← engine ← game; labs may import anything #eslint
- [pattern] Bridge pattern: no Phaser in src/core keeps logic engine-agnostic #bridge
- [shape] ECS systems are usually (world: GameWorld) => void and deterministic #ecs
- [spatial] Feet is the single internal spatial unit; PIXELS_PER_FOOT = 8; arena 160x90 ft mirrors the 1280x720 px canvas #units

## Relations

- part_of [[Crawler Project Overview]]
- constrained_by [[Conventions and Invariants]]
- decided_in [[Decisions Index]]
