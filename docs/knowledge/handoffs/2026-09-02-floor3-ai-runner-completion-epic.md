# Floor 3 AI runner completion epic

## Date

2026-09-02

## Persona

Producer

## Systems touched

ai-behavior-tree, hud-ux

## Apples

2🍎 estimated, 2🍎 actual — exact; this session authored one bounded epic and its coordinating handoff.

## Outcome

Created `floor-3-ai-runner-completion.epic.json` with a human-review gate and
three specialist-owned slices:

1. Game AI Engineer — shared Floor 3 objective and exit navigation.
2. UX Designer — autonomous handling of every blocking Floor 3 visual surface.
3. QA Engineer — the dependent dual-runner acceptance gate.

The hard gate is one fixed seed completing Floor 3 through both the production
headless runner and visual AI Runner Lab. The tests prohibit forced KOs,
teleports, direct world mutation, manual play after launch, and runner-specific
progression shortcuts. The visual test also requires at least 10 consecutive
simulated seconds alive outside the protected entrance.

Balance, win rate, broad sweeps, release flags, and other floors are explicitly
out of scope.

## Planning corrections

The generic Producer decomposition proposed unrelated floor-generation,
graphics, and core slices and failed to recognize the confirmed hard gate.
Repository inspection narrowed the graph to the actual seams: shared
BehaviorTreeAI objective navigation, AI Runner Lab modal automation, and
runtime acceptance coverage. Review feedback caught that the visual-dialog
slice's own acceptance requires a natural real-scene run through every Studio,
all Final Four rounds, and the kept-Companion picker — progress the current
visual runner cannot reliably make without the navigation slice. The visual
slice now depends on `shared-objective-navigation`; only that navigation slice
starts as an independent root, and both the visual slice and the QA gate wait
on it.

## Verification

- `node --test .github/scripts/epics/epic-create.test.mjs` — 39/39 passed,
  including validation of every committed epic file and unique epic ID.
- `npm run docs:check` — passed.
- `npm run verify:fast` — passed.
- `npm run verify:pr-prereqs` — passed.
- Secret scan — no secrets detected.
- Automated code review — no findings.
- CodeQL — skipped as a declared docs/metadata-only trivial change.
