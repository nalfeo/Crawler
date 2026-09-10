# ADR 0106: Floor 4 Green Room interaction and economy accounting

## Status

Accepted

## Date

2026-09-09

## Estimated Complexity

🍎 x 3 — coordinates the existing Floor 4 scenario, shared shop UI, and run telemetry without adding a system.

## Context

The Floor 4 Green Room offers optional sponsor-table purchases between acts.
The scene must show that shop only once per visit so the same marker can then
confirm the next act. Its offer count exceeds the shared panel's fixed visible
rows. Headliner appearance fees fund these purchases but previously bypassed
the run gold ledger, making earned and spent totals incomparable.

## Decision

Keep the scenario as the source of visit identity and purchase authority. The
scene records the visit index it has shown, presents the shared shop only for
human input, and lets automated input continue through the scenario marker.
The shared shop UI paginates rows, while appearance fees enter a dedicated
gold-ledger income counter included in economy summaries and CLI output.

## Consequences

### Positive

- **POS-001**: Human players can shop once and then progress through every Green Room marker.
- **POS-002**: All sponsor offers remain reachable without changing authored stock.
- **POS-003**: Economy summaries reconcile Floor 4 fee income with Green Room spending.

### Negative

- **NEG-001**: The shared shop adds page-navigation state and a page-control hint.
- **NEG-002**: Automated visual runs intentionally do not inspect optional sponsor stock.

### Risks

- **RSK-001**: Future input-capture modes must remain appropriate for bypassing optional modal UI.

## Alternatives Considered

### Keep reopening the shop until exit

- **ALT-001**: Reuse the transient panel-open flag as the visit gate.
- **ALT-002**: Rejected because closing the panel makes the marker unable to reach its confirmation modal.

### Render every sponsor offer in one panel

- **ALT-003**: Preserve the unbounded row list and fixed-height panel.
- **ALT-004**: Rejected because later rows render outside the panel and viewport.

### Exclude Floor 4 purchases from economy telemetry

- **ALT-005**: Keep Floor 1-only income and spending totals unchanged.
- **ALT-006**: Rejected because Green Room purchases already use the shared ledger and would leave totals inconsistent.
