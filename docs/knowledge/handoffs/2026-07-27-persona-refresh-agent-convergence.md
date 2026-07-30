# Persona refresh + agent convergence

**Date:** 2026-07-27
**Apples:** estimated 3🍎 / actual 3🍎
**Persona:** Producer → DevOps Engineer (tooling/guards)

## Systems touched

agent-os, tooling

## What changed

Crawler had two drifting concepts: `docs/agent-os/personas/*.md` (13 doctrine docs
with a routing matrix) and `.github/agents/*.agent.md` (8 invocable agents). Nothing
connected them, and nothing enforced either one. This session made them one system
with a deterministic guard so it cannot rot again.

**Layer model.** Persona = doctrine (what a role owns, refuses, is measured by).
Agent = invocable entry point. Every persona names a canonical agent; every agent
links back to a persona doc.

**Roster changes (evidence-based, from a usage + implementation audit):**

- **AI Content Engineer retired → `game-ai-engineer` created.** This was a live
  routing bug, not staleness: the README routed `src/game/ai/**` to a persona whose
  declared core was Ollama runtime generation, which has **zero implementation**
  anywhere in `src/`. That path is deterministic behavior-tree/pathfinding/headless
  AI that must never touch an LLM.
- **Sound Designer retired** (3 source files, 1 commit/90d, no pipeline or gate).
  Its audio constraints moved into UX Designer.
- **Story Designer retired**, merged into Content Designer.
- **Playtester revived**, not retired. Lowest mention count in 867 handoffs, but it
  owns the most tooling (`ai:weapon-sweep`, `ai:winrate-sweep`, `ai:sweep-eval`) and
  the hardest gate (90%+ Floor 1 win rate). It was unreachable, not unneeded.
- **9 new agents** so every surviving persona is invocable.

**Asset convergence (the explicit ask).** `sprite-issue-factory.agent.md` was ~80%
duplicated with `asset-forge.agent.md`. It is deleted; `asset-forge` absorbed it as
an `issue-wave` execution mode next to the default `local` mode. Only the _generate_
step differs between modes — everything else is one shared loop. `issue-wave`
requires explicit human confirmation before opening issues.

**Boilerplate dedupe.** The same 6-line review-harness block was copy-pasted into all
13 personas. There is now one canonical "Standing rules for every persona" section in
the README and a one-line pointer per persona. (Duplicating repo-wide instructions is
the documented custom-agent anti-pattern #1.)

## Enforcement added

`scripts/agent/docs/check-personas.ts` now requires `## Agent` and `## Skills`
sections, validates persona→agent references exist, enforces canonical-agent
cardinality (no two personas claim the same canonical agent), requires every agent to
have a non-empty frontmatter `description` **and** a backlink to an existing persona
doc, and flags orphan agents.

`scripts/agent/docs/check-paths.ts` now also scans `.github/agents/` and
`docs/agent-os/personas/`, validates relative Markdown link targets (not just
backticked paths), and tracks fenced-code-block state properly.

Pure helpers are extracted to `scripts/agent/docs/doc-refs-lib.ts` with 47 unit tests
in `tests/unit/docs/doc-refs-lib.test.ts`.

## Observe before done

This is tooling/docs work with no runtime gameplay surface, so the real artifact is
the guard itself. Before: `check-personas.ts` passed on a repo where zero personas
named an agent and two agents (`perf-optimizer`, `velocity-engineer`) named no
persona. After: the strengthened guard **caught both of those as blocking errors** on
first run and they were fixed. `npm run docs:check` exits 0; `npm run verify:fast`
passes.

## Bugs found and fixed en route

- `scripts/agent/producer.ts` still mapped work to the deleted `Sound Designer` and
  `Story Designer`, and routed `ai` to Systems Engineer. Remapped; `game` is now
  mapped explicitly to Game Designer instead of arriving there via a silent catch-all.
- Two tests in `tests/unit/producer.test.ts` asserted the deleted persona names.
- `check-paths.ts` glob handling truncated at the wildcard offset, so a legitimate
  `src/shared/data/quests.*.json` resolved to the non-existent
  `src/shared/data/quests.` and failed. Now cuts to the deepest real directory.

## Gotchas for the next session

- `npm run docs:check` takes ~12 minutes locally (the handoff-archive dry run walks
  867 files). It is quiet for most of that — do not assume it hung.
- `npm run review:ledger -- validate` with no argument validates the
  **alphabetically last** ledger, not yours. Pass your ledger path explicitly.
- Long PowerShell one-liners with `|` after a `}` fail with
  `ParserError: An empty pipe element is not allowed`. Write a script file instead.

## Single routing manifest

The plan reviewer flagged that `scripts/agent/producer.ts` hardcoded its own persona
mapping — a third routing source of truth alongside the README matrix and the guard.
The human asked for that collapsed in the same PR, so it is done here:
`docs/agent-os/personas/routing.json` is now the one machine-readable source of truth.

- `scripts/agent/shared/persona-routing.ts` loads and validates it (fails loudly on a
  malformed manifest, and rejects two personas claiming the same system keyword —
  which would otherwise make decomposition silently order-dependent).
- `producer.ts` builds `personaMapping` from it, and takes its unrouted-system triage
  bucket from `unrouted_persona` instead of a hardcoded `'Producer'` literal.
- `check-personas.ts` asserts manifest ↔ persona docs are a bijection, that each
  entry's agent is that persona's **canonical** agent (not merely one it mentions),
  that every agent is a canonical agent or a listed sibling with a real `inherits`,
  and that the README Routing Matrix rows match the manifest exactly.

Adding a persona is now: edit `routing.json`, run `npm run docs:check`, and fix
everything it names.

**CRLF bug found and fixed while doing this.** `frontmatterDescription` fed raw file
text to the YAML parser. On a Windows checkout the final frontmatter line carries a
lone trailing `\r`, which the parser rejects with "Unexpected scalar at node end" —
so the agent-`description` check reported all 11 agents broken locally while passing
on LF-only CI. It now normalizes CRLF first, with a regression test.
