# Session Handoff: AI Runner lab exposes player personas

## Date

2026-08-17

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, devtools

## Apples

2🍎 exact

## What Was Done

The AI Runner lab now exposes the AI **player personas** (`new_player`,
`experienced_player`, `min_max_cheeser`, `explorer`) as a first-class option,
matching the headless CLI's `--persona` flag (issue #3041).

- Added a "Player persona" lil-gui dropdown in the existing "AI Modes (A/B)"
  folder, built from `PLAYER_PERSONAS` so a new persona in
  `src/game/ai/personas.ts` surfaces in the lab automatically.
- Collapsed three duplicated `new BehaviorTreeAI(...)` call-sites (initial build,
  `rebuildAiBrain`, `reseed`) into one `createAiBrain()` factory that spreads
  `getPersonaConfig(aiConfig.playerPersona)` and layers only the run-scoped
  `seed`/`debug` and the A/B mode selection on top. The old sites hand-copied a
  partial tuning subset (`aggression: 1`, `retreatThreshold`, `farmPullWeight`),
  which could silently drift from the persona presets.
- Selection persists across lab reloads (validated on read — an unknown persisted
  value falls back to the production baseline) and supports a `?persona=<id>`
  deep link with the same precedence rule as `?scenario=`.
- Surfaced the active persona in the telemetry strip (`#ai-player-persona`) and
  in `window.__aiRunnerDebug().playerPersona` so a headless harness can assert
  which cohort a browser run used.

Observed in the running lab (`npm run lab` → `?lab=ai-runner`, Playwright-driven):
before — no player-persona control existed anywhere in the lab (only the weapon
persona toggle); after — the dropdown lists all four personas, selecting
"Min-max cheeser" flips the telemetry cell and `__aiRunnerDebug().playerPersona`
to `min_max_cheeser` and rebuilds the brain, the choice survives a reload,
`?persona=new_player` wins over the persisted value, and `?persona=bogus` falls
back to `experienced_player`.

## Key Decisions Made

- **Default stays `experienced_player`**, whose preset is derived by construction
  from `DEFAULT_CONFIG`. A fresh lab session therefore reproduces the previous
  lab behavior and the shipped production tuning exactly — no silent balance
  change smuggled in behind a UI feature.
- **No per-knob sliders.** Personas are applied whole so a labelled lab run
  always matches the cohort, mirroring the truthfulness rule the headless CLI
  enforces via `personaConfigDivergence`.
- **One construction point.** The existing wiring test that counted three
  `DEFAULT_CONFIG.retreatThreshold` occurrences was updated to assert the new
  invariant (single `new BehaviorTreeAI(` call, persona spread, no tuning
  literals) rather than dropped.

## What's Next / Blockers

No blockers. Natural follow-ups: (a) show the persona in the session-recorder
metadata so recorded lab runs carry their cohort, and (b) consider a lab-side
divergence warning if per-knob overrides are ever added (the CLI already has
`personaConfigDivergence` for that).

## Retrospective

### Lessons Learned

- The lab's three duplicated AI-construction sites were guarded by a test that
  asserted an _occurrence count_ of a constant. That kind of assertion protects
  against literal drift but actively resists the better fix (de-duplication) —
  when consolidating, re-express the invariant instead of chasing the count.
- Playwright MCP was unavailable in this sandbox; driving `playwright` directly
  from a `/tmp` script against the vite lab server (which binds an ephemeral
  IPv6 port — read it from `ss -ltnp`, not from assumed 5173) worked fine for
  rule #9 observation.

### Mistakes Made

- First locator attempt used lil-gui's `.controller` class filter and timed out;
  selecting the `<select>` by its option text via `page.evaluate` was the robust
  path. Early signal: the GUI select enumeration already printed the option list,
  so the element was clearly present and the locator — not the feature — was wrong.

### Opportunities for Future Improvement

- The lab's persona and scenario deep links (`?persona=`, `?scenario=`) now share
  an identical URL-precedence pattern; a tiny shared helper would keep the two
  from drifting if a third option is added.
- `AiRunnerDebugSnapshot` is growing organically; an e2e assertion over its shape
  would catch accidental field removal by future refactors.
