# Handoff: Azure credit dashboard canvas

## Date

2026-07-15

## Persona

DevOps Engineer

## Systems touched

devtools, azure-infra

## Apples

2🍎 estimated, 3🍎 actual (📉 under-estimated: promoting the personal canvas into
a tested project extension added a pure cost-model module and repository guard
coverage beyond the original single-file dashboard).

## What Was Done

Added `.github/extensions/azure-credit-dashboard/`, a project-scoped Copilot
canvas that uses the authenticated Azure CLI account to show:

- current Visual Studio monthly credit allowance, used amount, remaining amount,
  and billing-cycle dates;
- spend grouped by Azure service, with a plain-English largest-cost summary;
- day-by-day and billing-cycle-aligned week-by-week spend charts;
- expandable Foundry Models costs grouped by Azure OpenAI model family;
- bounded Azure API retry handling and a two-minute refresh cache.

The extension reads paginated `Microsoft.Consumption/usageDetails` records rather
than the heavily throttled Cost Management aggregation endpoint. It stores no
credentials or access tokens. On Windows it strips Copilot-only environment
variables before invoking Azure CLI to avoid corrupting Azure's client-session
claims.

Pure aggregation and product-name normalization live in
`lib/cost-model.mjs`. The guard suite now covers model parsing, service
classification, daily/weekly/service/model cent reconciliation, and
fractional-cent allocation.

## Runtime Observation

Observed in the real project canvas (`project:azure-credit-dashboard`, instance
`azure-credit-project`) against the active Visual Studio Enterprise subscription:

- the canvas opened with `$149.01` remaining of `$150`;
- current-cycle usage reconciled to `$0.99` across service, daily, and weekly
  totals;
- expanding Foundry Models showed `GPT-4o 1120 — $0.90`;
- the model subtotal exactly matched the `$0.90` Foundry Models parent total.

Before the model drill-down, Foundry Models was a single opaque `$0.90` row.
Afterward, the live iframe disclosure exposed the responsible model family.

## Key Decisions

- Use `usageDetails` because it exposes exact `cost`, `date`, `product`, and
  `consumedService` fields and avoids persistent `429` responses from grouped
  Cost Management queries.
- Normalize Azure OpenAI input, cached-input, and output token products into one
  model-family row while preserving exact cent totals.
- Keep the default allowance configurable through canvas input, defaulting to
  the Visual Studio Enterprise `$150` monthly credit.

## Review

Review ledger:
`docs/knowledge/review-ledgers/2026-07-15-azure-credit-dashboard.review-ledger.json`.
The declared 2🍎 tier requires no separate-model review stages.

A voluntary final diff review found and resolved three lifecycle defects:
concurrent refreshes now share one in-flight Azure query, closing the canvas
aborts refresh work and force-closes HTTP connections, and trend toggles safely
ignore clicks before initial data arrives.

## Next

No known blockers.
