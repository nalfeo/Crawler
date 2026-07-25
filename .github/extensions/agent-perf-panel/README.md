# agent-perf-panel

Copilot canvas extension for investigating the **performance and execution of
agents, sub-agents, skills, and tools** during Crawler work sessions. Answers
questions like:

- Where are we spending wall time?
- Where are we serial vs parallel? What is our max concurrency?
- What are the long poles (individual tool calls, tool types, hooks)?
- Where are we spending tokens, and how do they compare to the model's
  context-window budget?
- When did we compact context, and what was in it (system / conversation /
  tool defs)?
- How often do sub-agents and skills get invoked, and how long do they run?

The panel is **local-only**. All data is read from the Copilot session store
already on disk — nothing is sent over the network.

## Data sources

| Source                                       | Used for                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `~/.copilot/session-store.db` (SQLite)       | Session listing, repository grouping, branch/summary metadata                            |
| `~/.copilot/session-state/<id>/events.jsonl` | Per-event stream (tool starts/completes, hooks, tokens, compactions, skills, sub-agents) |

Requires **Node 24+** for the built-in `node:sqlite` module (unflagged since
Node 24; introduced experimentally behind `--experimental-sqlite` in Node 22.5),
so no native dependencies are required.

## Views

**Per-session** (pick a session from the top-bar dropdown):

- **Overview** — headline KPIs: wall time, tool time, serial vs parallel,
  API calls, output tokens, peak context vs budget, hook time, sub-agent /
  skill counts, error counts.
- **Waterfall** — a true tool waterfall on a single shared **wall-clock** time
  axis: one lane per tool call, ordered by real start time and positioned by its
  actual start + duration, so serial calls cascade down-and-right and overlapping
  (parallel) calls stack as bars sharing an x-range. Idle gaps show as real empty
  stretches. Faint vertical turn boundaries + inline turn separators group the
  lanes, and a tool-concurrency curve over time sits below. Directly above the
  lanes, a **context-pressure strip** shares the exact same axis: one marker per
  compaction at its recorded pre-compaction token high-water-mark, with a dashed
  configured-budget line. These are honest **discrete samples** — the CLI log only
  records context size when a compaction fires, so no continuous line is drawn or
  interpolated (sessions with no compactions show an explicit note).
- **Long poles** — top-20 individual tool calls + aggregate by tool name
  (count / total / avg / p50 / p95 / max / failures / context bytes), plus a
  **Biggest context sinks** table ranking the same tools by bytes pulled into
  context rather than by latency. These two orders routinely disagree — a 10ms
  `grep` returning 300KB costs far more context than a 60s build returning 500
  bytes — and context cost, not latency, is what drives compaction.
- **Tokens & context** — cumulative output-token curve with compaction
  markers, plus a context-window budget breakdown at compaction (system /
  conversation / tool definitions).
- **Sub-agents & skills** — nested view of `agent.started` / `agent.completed`
  events and `skill.invoked` events.
- **Hooks / guards** — hook-type aggregate; a proxy for how much guard work is
  on the critical path.

**Aggregate** (leave the session dropdown on "aggregate view"):

- KPIs summed across all matching sessions.
- Session leaderboard sortable by wall time, tokens, parallelism, etc.
- Long poles across the whole date range.
- Model / token breakdown (aggregate).

## Opening the panel

From chat:

> Open the agent perf panel.

Or explicitly:

```
open_canvas({ canvasId: 'agent-perf-panel', instanceId: 'app-1' })
```

Optional input on open:

```json
{ "sessionId": "0269ec21-...", "repository": "nalfeo/Crawler" }
```

## Agent-callable actions

The same data primitives are exposed for programmatic use by sub-agents:

- `list_sessions({ repository?, sinceIso?, untilIso?, limit? })`
- `analyze_session({ sessionId })`
- `aggregate({ repository?, sinceIso?, untilIso?, limit? })`

## File layout

- `extension.mjs` — canvas registration, HTTP server, JSON routes.
- `renderer.mjs` — single-page HTML + CSS + client JS (vanilla, hand-rolled SVG).
- `analyzer.mjs` — streams events.jsonl and produces the rich summary shape.
- `sessions-db.mjs` — read-only accessor over `session-store.db`.
- `aggregator.mjs` — cross-session rollup.

## Known limitations

- **Input-token counts** (`inputTokens`, `cacheReadTokens`) are only recorded
  locally in a subset of assistant messages. If the field is missing, the
  panel shows `—` rather than fabricating a number.
- **Codex-cli sessions** (`producer: "codex-cli"`, e.g. `gpt-5.3-codex`) do
  not emit `assistant.usage` events at all — most token panels will be
  blank for those sessions.
- **Sub-agent detection** requires the runtime to emit `agent.started` /
  `agent.completed` events. Some model / runtime combinations do not, in
  which case sub-agent spawns invoked via the `task` tool will still show
  up in Long-poles as `task` calls but not on the Sub-agents tab.
- Context-window budgets are hard-coded per model prefix
  (claude-\* = 200k, gpt-5.\* = 400k, gemini-\* = 1M). Percentages are
  approximate.
- **Context-sink bytes are a proxy for tokens.** They count the characters of a
  tool's returned payload, which is good enough to rank sinks against each other
  but must never be presented as a token count.

## Improving this panel

The `velocity-engineer` agent is required to leave this panel measurably more useful
after every investigation — see
[`docs/agent-os/policies/velocity-lab-policy.md`](../../../docs/agent-os/policies/velocity-lab-policy.md)
§12 and [`.github/skills/session-telemetry/SKILL.md`](../../skills/session-telemetry/SKILL.md)
for the procedure.

Two rules worth repeating here, because both have already caused silent-zero bugs:

1. **Verify a field exists in a real `events.jsonl` before coding against it.** Several
   plausible-looking fields do not exist — there is no `inputTokens` on
   `assistant.message`, and no `toolName` on `tool.execution_complete` (join to
   `tool.execution_start` on `toolCallId` instead).
2. **Check a new metric against a real session, not only the fixture.** A metric that
   passes `tests/analyzer.test.mjs` and reads zero in production is worse than no metric,
   because it looks like data.
