---
name: create-architectural-decision-record
description: 'Create an Architectural Decision Record (ADR) document for AI-optimized decision documentation.'
---

# Create Architectural Decision Record

Create an ADR document for `${input:DecisionTitle}` using structured formatting optimized for AI consumption and human readability.

## Inputs

- **Context**: `${input:Context}`
- **Decision**: `${input:Decision}`
- **Alternatives**: `${input:Alternatives}`
- **Stakeholders**: `${input:Stakeholders}`

## Input Validation

If any of the required inputs are not provided or cannot be determined from the conversation history, ask the user to provide the missing information before proceeding with ADR generation. When invoked from PR shepherding or CI Recovery to address a missing-ADR review thread, first infer the context, decision, alternatives, and stakeholders from the PR diff, review thread, and linked policy/docs; ask only when the underlying decision itself is unclear or requires human product judgment.

## Requirements

- Use precise, unambiguous language
- Follow this repo's ADR template at `docs/knowledge/adr/TEMPLATE.md` (no YAML front matter)
- Include both positive and negative consequences
- Document alternatives with rejection rationale
- Structure for machine parsing and human reference
- Use coded bullet points (3-4 letter codes + 3-digit numbers) for multi-item sections

The ADR must be saved in this repo's `docs/knowledge/adr/` directory using the naming convention `NNNN-[title-slug].md` (4-digit number, **no** `adr-` prefix), where NNNN is the next sequential number (e.g., `0029-database-selection.md`). This matches the existing ADRs (e.g. `docs/knowledge/adr/0017-azure-workflow-state-persistence.md`) and keeps the file in scope for the ADR consistency checker (`scripts/agent/docs/check-adr-consistency.ts`), which only scans `docs/knowledge/adr/*.md`.

## Required Documentation Structure

The documentation file must follow this repo's ADR template (`docs/knowledge/adr/TEMPLATE.md`). Do **not** add YAML front matter — the repo template uses none. Fill out every section; the coded bullet points (3-4 letter codes + 3-digit numbers) are an AI-parsing aid you may keep within each section.

```md
# ADR NNNN: [Decision Title]

## Status

**Proposed** | Accepted | Deprecated | Superseded by NNNN

## Date

YYYY-MM-DD

## Estimated Complexity

🍎 x N — [one-line reason, e.g. "touches 2 systems but no new lab required"]

## Context

[Problem statement, technical constraints, business requirements, and environmental factors requiring this decision.]

## Decision

[Chosen solution with clear rationale for selection.]

## Consequences

### Positive

- **POS-001**: [Beneficial outcomes and advantages]
- **POS-002**: [Performance, maintainability, scalability improvements]

### Negative

- **NEG-001**: [Trade-offs, limitations, drawbacks]
- **NEG-002**: [Technical debt or complexity introduced]

### Risks

- **RSK-001**: [Risks and future challenges]

## Alternatives Considered

### [Alternative 1 Name]

- **ALT-001**: **Description**: [Brief technical description]
- **ALT-002**: **Rejection Reason**: [Why this option was not selected]

### [Alternative 2 Name]

- **ALT-003**: **Description**: [Brief technical description]
- **ALT-004**: **Rejection Reason**: [Why this option was not selected]
```
