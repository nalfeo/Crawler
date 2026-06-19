# Session Handoff: Headless AI Runner & Rule-Based AI Player

## Date

2026-06-17

## Apples

Estimated: 🍎🍎🍎🍎  
Actual: 🍎🍎🍎🍎  
Verdict: 🎯 Exact — implemented complete headless runner system with rule-based AI, achieved 40K+ FPS performance, and created visual lab for debugging.

Hello kitties: 4/5 = 0.80 🎀

## What Was Done

Implemented a headless AI runner and traditional rule-based AI that plays Crawler through simulated human input:

### Core AI System

1. **AI Input Provider Interface** (`src/game/ai/types.ts`)
   - `AIInputProvider` interface for pluggable AI systems
   - `AIState` enum: EXPLORE, ENGAGE, RETREAT, COLLECT, INTERACT
   - `AIDecision` tracking: state, target, reason
   - `RunStats` for performance metrics

2. **Rule-Based AI** (`src/game/ai/ai-input-provider.ts`)
   - State machine with 5 behavioral states
   - Decision logic: target prioritization (enemies > XP gems > NPCs)
   - Pathfinding integration via `findTilePath`
   - Collision avoidance and stuck detection
   - Deterministic behavior using SeededRandom

### Headless Runner

3. **Simulation Step Extraction** (`src/game/ai/simulation-step.ts`)
   - Extracted core ECS loop from MainGameScene
   - Standalone `runSimulationStep()` function
   - Supports custom pre/post systems
   - Enables both headless and visual modes

4. **Headless Runner** (`src/game/ai/headless-runner.ts`)
   - Pure ECS simulation, no Phaser
   - Achieved **40,650 FPS** (40x target performance!)
   - Configurable: seed, max frames, wall-time limit
   - Progress reporting and metrics collection
   - Win/loss condition detection

5. **CLI Tool** (`src/game/ai/headless-runner-cli.ts`)
   - Command-line interface with full options
   - npm script: `npm run ai:headless`
   - JSON output for batch analysis
   - Example: `npm run ai:headless -- --seed 42 --max-frames 10000`

### Visual Lab

6. **AI Runner Lab** (`src/labs/ai-runner-lab/`)
   - Watch AI play in real-time via Phaser
   - Live decision display: state, reason, target
   - Access via `npm run lab` → `?lab=ai-runner`
   - Uses same InputState interface as humans
   - No special programmatic access

## What's Next

### Immediate Follow-ups

1. **AI Refinement**
   - Improve targeting priority (consider threat level, distance)
   - Add weapon-aware positioning (melee vs ranged tactics)
   - Implement safe-room awareness for healing
   - Add stair/quest objective seeking

2. **Testing**
   - Unit tests for AI decision functions
   - Integration tests for headless runs
   - Property-based tests: survival rate across seeds
   - Regression tests in CI

3. **Documentation**
   - Add AI system to AGENTS.md
   - Document headless runner usage in README
   - Add examples and common use cases

### Future Enhancements

- Batch runner for testing across multiple seeds
- Result aggregation and analysis scripts
- Visual mode npm script (optional improvement)
- MainGameScene refactor to support AI input provider natively
- Advanced AI: weapon cooldown tracking, item usage, skill selection

## Blockers

None.

## Branch State

- Branch: `copilot/design-headless-runner-ai`
- All tests passing: yes
- PR created: no (create with `gh pr create` or runtime-tools-create_pull_request)

## Test Results

- `npm run verify:fast` ✅ All 1222 tests passed
- Headless runner: 40,650 FPS achieved (target was 1000 FPS)
- Lab registered and accessible via `?lab=ai-runner`

## Key Decisions Made

1. **Traditional AI Only**: Confirmed with user to use rule-based AI, no LLM integration
2. **Input Simulation**: AI must use standard `InputState`, no special API access
3. **Extracted Simulation Loop**: Created reusable `runSimulationStep()` for both modes
4. **Performance First**: Headless mode optimized for speed (achieved 40K FPS)
5. **Lab-Gated Development**: Created lab before shipping (per ADR-002)

## Files Created

```
src/game/ai/
├── ai-input-provider.ts       # Rule-based AI implementation
├── types.ts                    # AI interfaces and types
├── index.ts                    # Module exports
├── simulation-step.ts          # Extracted ECS loop
├── headless-runner.ts          # Pure headless simulation
└── headless-runner-cli.ts      # CLI entry point

src/labs/ai-runner-lab/
└── index.ts                    # Visual debugging lab
```

## Files Modified

- `package.json`: Added `ai:headless` npm script
- `src/lab-main.ts`: Registered `ai-runner` lab

## Performance Metrics

- Headless simulation: **40,650 FPS** (10,000 frames in 0.2s wall time)
- Simulated 166.7 seconds of game time in 0.2 seconds
- 40x faster than 1000 FPS target
- Sufficient for rapid batch testing and AI training

## Architecture Notes

- AI decision logic is pure: deterministic given world state + seed
- Uses existing pathfinding, collision, and ECS systems
- No shortcuts: AI simulates human input through `InputState`
- Headless runner is true ECS-only (no Phaser dependency)
- Visual lab uses real MainGameScene with AI input provider swapped in

## Store Memory Candidates

None identified - no new conventions or patterns worth storing.
