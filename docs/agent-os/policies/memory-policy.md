# Memory Policy

## Purpose

This project uses a three-tier memory model so agents can load the smallest useful context at the right time.

## Memory Tiers

- **Tier 1 — Hot memory:** Always-loaded rules such as the constitution, AGENTS guidance, and critical harness instructions. Keep this tier small because every extra line taxes every session.
- **Tier 2 — Codified memory:** Stable just-in-time docs such as personas, policies, guides, and ADRs. This is the operating manual agents should load when the task matches the topic.
- **Tier 3 — On-demand memory:** Handoffs, design notes, lab READMEs, investigations, and other reference material loaded only when needed.

## Mandatory Handoff Protocol

Every implementation session (merge-intent code change) writes a handoff file before ending work.

- Location: `docs/knowledge/handoffs/`
- Naming: `YYYY-MM-DD-<slug>.md`
- Minimum contents: summary of work completed, files touched, verification run, unresolved issues, and recommended next steps
- Rule: no implementation session ends silently; investigation/repro sessions without merge-intent fixes may skip handoff paperwork

## ADR Threshold

Create an ADR for any decision that affects **two or more systems**, layers, or workflows.

- Store ADRs in `docs/knowledge/adr/`
- Cross-link the ADR from any policy or guide it changes
- Prefer ADRs for architectural, testing, CI, AI-content, or memory-governance decisions
- If CI Recovery or PR shepherding discovers that a PR is missing a required ADR,
  the agent should author the ADR from the PR diff/review context instead of
  escalating to the human. Escalate only when the underlying decision itself is
  unclear or requires human product judgment.

## Promotion Rules

- **Tier 3 → Tier 2:** Promote when the same knowledge is referenced by **3 or more sessions** or has become repeatable operating guidance.
- **Tier 2 → Tier 1:** Promote only when agents repeatedly violate the rule without seeing it in hot memory, and the cost of failure is higher than the cost of always loading it.
- **Principle:** promotion to Tier 1 is expensive; default to Tier 2 unless there is clear evidence the rule must always be present.

## Retirement Rules

- Handoffs older than **30 days** move to an archive location rather than staying in the active handoff set.
- Superseded ADRs remain in the repository and are marked as superseded with a pointer to the replacement ADR.
- Stale policy, guide, or persona docs older than **90 days** without recent references should be archived for review rather than deleted.

## Archival Principle

Nothing is deleted, only archived.

- Preserve history for future agents.
- Mark retired documents clearly so active guidance stays easy to find.
- Prefer archiving with a replacement link, rationale, and date.
