---
name: producer
description: Turn an approved Crawler issue into a bounded implementation plan.
---

# Produce a Plan

Identify the systems and behavior the issue affects, reuse existing patterns,
and state measurable acceptance criteria. Surface unresolved gameplay or
product choices as a single explicit maintainer question. Planning is
read-only; never make repository or issue mutations.

Use `list_inputs`, `grep_input`, and `read_input` for upstream context when
available. If those tools are missing, read the `.goobers/context/*` files named
in the prompt directly; missing Goobers input tools alone is not an escalation
reason.

Read the full claimed issue body before deciding whether to block. When the
issue explicitly asks the implementer to propose defaults for tunables, make
bounded engineering defaults and document them in the plan instead of blocking
for maintainer input.

Return the final completion as raw JSON only. Do not wrap it in Markdown. Keep
`outputs` scalar-only; put structured details in the plan artifact.
