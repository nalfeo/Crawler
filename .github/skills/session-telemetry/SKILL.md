---
name: session-telemetry
description: >-
  Read real Copilot session telemetry through the agent-perf panel, find where turns,
  tokens, and context are actually going, and close the gaps in that telemetry. Use when
  asked to "why did this session compact", "where are my tokens going", "what is the long
  pole in this session", "reduce context usage", "improve the perf panel", "what telemetry
  are we missing", or as the instrumentation step of any velocity investigation. Covers
  reading a session's summary programmatically, ranking context sinks by tool, diagnosing
  compaction causes, and adding a new metric to the panel with a test.
---

# Session telemetry

Answers two questions, in this order:

1. **Where did this session's turns, tokens, and context actually go?**
2. **What did I want to know and could not?** — and then: instrument it.

The second question is the point. A velocity investigation that stops at "the data does
not show that" has produced nothing. In that case the deliverable _is_ the missing metric.

## Why context is a first-class metric

Output tokens measure what the agent _produced_. Context measures what it _carried_. Only
the second causes compaction, and compaction is charged twice:

- **In tokens** — a summarisation call over the whole window.
- **In quality** — afterwards the agent reasons from a lossy paraphrase of what it knew.

So a change that keeps a 300KB payload out of the window can beat a change that makes the
model think faster, even though only the latter looks like "performance work".

Crucially, **latency ranking and context ranking are different orders**. On a real session
the slowest tools were `read_powershell, ask_user, powershell` while the biggest context
sinks were `grep, powershell, view`. Reading only the timing table would have missed the
actual cause of compaction.

## Reading a session

The analyzer is importable, so you do not need the UI to get numbers:

```js
const base = '.github/extensions/agent-perf-panel/';
const { analyzeSession, buildSummary } = await import(base + 'analyzer.mjs');

const raw = await analyzeSession(sessionId); // reads ~/.copilot/session-state/<id>/events.jsonl
const s = buildSummary(raw);

s.totals; // toolCalls, apiCalls, tokens {input, output, cost}, peakContextTokens
s.toolAggregates; // per tool: count, totalMs, p50/p95/max, failures, totalResultBytes
s.contextSinks; // same rows ranked by context cost, not latency
s.longestTools; // individual long poles
s.contextEvents; // compaction boundaries with preTokens / systemTokens
```

Use `isSafeSessionId()` before building any path from a session id.

## Diagnosing a compaction

Work down this list; stop at the first that explains the bulk of the window.

| Check                                 | What it means                                                  |
| ------------------------------------- | -------------------------------------------------------------- |
| `s.contextSinks[0]` dominates         | One tool is the cause — narrow its output or its call sites    |
| `maxResultBytes` >> `avgResultBytes`  | A single pathological call, not a habit — fix that call        |
| High `count`, modest `avgResultBytes` | Death by a thousand reads — batch or target them               |
| Sinks flat, context still full        | The conversation itself is long — delegate, do not trim tools  |
| `contextEvents[].systemTokens` large  | Fixed overhead — tool/skill surface area, not session behavior |

The distinction matters because the remedies are unrelated: a fat tool result is fixed by
changing the tool; a long conversation is fixed by moving work into a sub-agent whose
context is discarded on return.

## Improving the telemetry (the ratchet)

Every velocity investigation leaves the panel more useful than it found it. Not optional,
and not satisfied by cosmetics.

A qualifying improvement is one of:

- a **new metric** answering a question you actually hit during the investigation;
- a **sharper breakdown** of an existing metric (per-tool, per-turn, per-agent);
- a **fixed misattribution** — a number credited to the wrong thing;
- a **removed display** that was misleading, unread, or duplicated.

### How to add a metric

1. **Verify the field exists in real data first.** Read an actual `events.jsonl` and check
   the key names. Do not infer them from adjacent code — several plausible fields
   (`inputTokens` on `assistant.message`, `toolName` on `tool.execution_complete`) do not
   exist, and code written against them silently reports zero.
2. Aggregate in `analyzer.mjs` (`buildSummary`), not in the renderer.
3. Render in `renderer.mjs`.
4. Add a test to `tests/analyzer.test.mjs` that fails without the change.
5. Run `node --test .github/extensions/agent-perf-panel/tests/analyzer.test.mjs`.
6. **Verify against a real session**, not only the fixture. A metric that passes unit tests
   and reads zero in production is worse than no metric, because it looks like data.

### Event shapes (verified against a live log)

| Event                         | Fields you can rely on                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `tool.execution_start`        | `toolCallId`, `toolName`, `arguments`, `model`, `turnId`     |
| `tool.execution_complete`     | `toolCallId`, `success`, `result.{content,detailedContent}`  |
| `assistant.message`           | `outputTokens`, `content`, `toolRequests`, `model`, `turnId` |
| `session.compaction_complete` | `preCompactionTokens`, `compactionTokensUsed`, `success`     |

Tool **names** live on `execution_start` and tool **results** on `execution_complete`; join
them on `toolCallId`. There is no session-wide `inputTokens` field — peak context is only
observable at compaction boundaries.

## Feeding the lab

`scripts/agent/velocity/context.ts` reads the same log for A/B trials, so panel metrics and
experiment metrics agree by construction. `toolResultBytes` and `compactions` are comparable
metrics in experiment reports: **an arm can win on context alone.**

If you add a metric here that an experiment should compare, add it to `ContextMetrics` and
to `COMPARED_METRICS` in `experiment.ts` in the same change — otherwise the panel and the
lab drift apart, and the lab is the one that decides.

## Honest limits

- Context metrics come from the **session event log**, written by the CLI, not by us. If it
  is missing, metrics read zero — that is missing data, not a clean session. Distinguish
  the two before reporting.
- `peakContextTokens` is only sampled at compaction. A session that never compacted reports
  `0`, meaning "never got close enough to be measured", not "used no context".
- Byte counts are a proxy for tokens. Good enough for ranking sinks; never present them as
  token counts.

## Related

- `.github/extensions/agent-perf-panel/README.md`
- `.github/skills/bottleneck-scan/SKILL.md` — process-side timing, not session-side
- `.github/skills/velocity-lab/SKILL.md` — proving a fix with an A/B
- `docs/agent-os/policies/velocity-lab-policy.md`
