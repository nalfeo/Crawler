# Crawler — Game Design Document

## Elevator Pitch

A crafting-focused vampire-survivors-like set inside a brutal intergalactic reality show dungeon. An ancient AI showrunner ("The Director") narrates your descent through procedurally generated floors while alien audiences bet on your survival, send sponsor gifts, and vote on what happens next. Deep crafting between floors, zany item synergies, and rogue-lite progression across "seasons" of the show. Local AI (Ollama) generates The Director's commentary, item descriptions, and audience reactions — making every run feel unique.

**Tone:** Dark humor meets spectacle. Squid Game stakes, American Gladiators showmanship, Dungeon Crawler Carl absurdity.

## Genre DNA

From Vampire Survivors: Auto-attack, XP gems, level-up choices, power curve, 500-1000+ entities, visual chaos as reward.
From Brotato: Inter-wave shop, 6 weapon slots, character roster (30+), danger levels.
From Halls of Torment: Quest chains, trait/skill system, RPG depth.
From DRG Survivor: Short floors linked into delves, resource gathering during combat, safe rooms.
From Hades: Story advances through failure, hub with NPCs, "every run contributes."
From Binding of Isaac / Noita: Emergent item interactions, iceberg depth, discovery as reward.

## The Reality Show Frame

**The Gradient:** Ancient post-biological collective. Experience emotion vicariously by watching biological life under extreme stress. Harvesting civilizations as entertainment for ~8,000 years.

**The Director:** Broadcast intelligence/showrunner. 1980s game show host enthusiasm + reality TV producer menace + slight incoherence of ancient system. Each playthrough has a "season quirk" (competitive baking, existential philosophy, etc.). Not evil — just optimizing for engagement.

**Broadcast Score:** TV-style popularity meter. Higher = better sponsor gifts. Earned by kill streaks, close calls, style plays.

**Sponsor Gifts:** Care packages between floors. Quality scales with Broadcast Score. Range from helpful to trollish. Themed by current sponsors.

**Audience Layer:** Scrolling chat overlay (Ollama-generated). Vote prompts at safe rooms. "Trending" system affects next floor.

## Core Game Loop

```
Production Office → Briefing → Floor Combat (3-5 min) → Boss → Commercial Break (safe room) → Repeat 3-5 floors → Season Finale → Meta-progression
```

Session target: 20-35 minutes per episode.

## Three-Tier Crafting

Tier 1 (Mid-Combat): VS-style level-up picks, 1-of-3 choices.
Tier 2 (Safe Room): Craft Table, Sponsor Kiosk, Audience Wall, Green Room NPC, Floor Map. 60s mandatory, 90-120s optimal, debuff after 3min.
Tier 3 (Between-Run): Production Office — Ratings currency → permanent unlocks, sponsor contracts, base upgrades.

## Character System

Each character = different game (Brotato model). Start with 3-5, unlock 15-20 across 20 runs. Unique weapon, passive, personality. Skill trees per character. Goal: 50+ viable builds.

## Floor Design

Theme + gimmick + boss. "Broadcast Deadline" timer triggers boss. Sample: Shopping District, Nostalgia Floor, Game Show Floor, Naturalist Floor, Archive Floor. Between-floor: Season Pitches (audience votes), Rebranding Events, Sponsor Takeovers.

**Floor 2 — "Family Matters"** (designed): an open cave system of feuding mob families the player can befriend, betray, or exterminate. Content bible: [floor2-families-and-resources.md](floor2-families-and-resources.md); system spec: [`.specify/specs/floor2-family-territories.md`](../../../.specify/specs/floor2-family-territories.md); architecture: [ADR 0040](../adr/0040-floor2-family-territory-and-relationship-architecture.md).

**Floor 3 — "The Companion League"** (designed): a monster-taming game-show floor where the player commands auto-battling Companions instead of fighting. Content bible: [floor3-companion-league.md](floor3-companion-league.md); system spec: [`.specify/specs/floor3-companion-league.md`](../../../.specify/specs/floor3-companion-league.md); architecture: [ADR 0071](../adr/0071-floor3-companion-league.md).

**Floor 4 — "The Main Event"** (designed): the first non-exploration floor — a ten-minute survival arena in five two-minute acts, a Headliner boss closing each act, and a Green Room safe room between acts whose sponsor stock re-randomizes every visit. This is the clearest expression of the Brotato DNA above. Content bible: [floor4-arena.md](floor4-arena.md); system spec: [`.specify/specs/floor4-arena.md`](../../../.specify/specs/floor4-arena.md); architecture: [ADR 0090](../adr/0090-floor4-arena.md).

## Rogue-Lite Meta-Progression

Persists: Ratings currency, item pool unlocks, character roster, season narrative, sponsor contracts, Production Office upgrades, cosmetics.
"Never Waste a Run" — every run earns Ratings, story advances through failure.
Progression: Hours 1-3 learn, 3-10 mastery, 10-20 deep crafting, 20-40 all content, 40+ community.

## Difficulty

In-run: timer-based enemy scaling, elite enemies, floor boss.
Cross-run: "Producer Notes" (Hades Heat equivalent), per-character ladders.

## Dopamine Hits

1. Gem-hoover sound cascade. 2. Weapon evolution moment. 3. Synergy discovery. 4. Broadcast Score spike. 5. Director commentary. 6. Sponsor gift reveal. 7. Power curve. 8. Safe room craft payoff. 9. Audience vote. 10. Season completion cascade. 11. Character unlock. 12. Secret discovery.

## Prototype Scope

Must have: Player movement + auto-attack, enemy spawning + XP gems, level-up choices, one floor + boss, basic safe room + crafting, Director voice (Ollama), Broadcast Score.
Deferred: Production Office, full meta-progression, skill trees, multiplayer, polished art/sound.
