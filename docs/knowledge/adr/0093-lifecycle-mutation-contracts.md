# ADR 0093: Lifecycle mutation contracts and single-writer inventory

## Status

Accepted

## Date

2026-08-28

## Estimated Complexity

🍎🍎🍎 — tooling-only governance cap; six workflow mutation surfaces, versioned
contracts, deterministic validation, and CI wiring.

## Context

Crawler's CI Recovery, merge train, and Goobers workflows mutate related GitHub
resources. Their existing workflow-level concurrency and expected SHA/base
checks are useful safety boundaries, but the mutation owners and replay
semantics were not represented in one machine-checkable contract. A shadow-mode
migration must not introduce a second writer or begin before these paths are
accounted for.

## Decision

Create `.github/contracts/mutation-inventory.json` as the authoritative
inventory for the six lifecycle workflows. Every mutation path names its
implementation owner, exact source anchor, contract type, permissions, and
concurrency boundary. Read-only checkout, downloads, validation, tests, and
artifact uploads are explicitly recorded as non-mutations.

Use versioned v1 invocation and decision schemas. A canonical resource key is
`crawler:v1:<resource-kind>:<repository>:<resource-id>`, and an idempotency key
is `<contractVersion>:<resourceKey>:<operation>:<headSha-or-generation>:<attempt>`.
Ownership transitions are `unowned -> claimed -> active -> released`, with
deterministic expiry and takeover states. Writes require the current fencing
token; stale owners, malformed contracts, ambiguous outcomes, and replayed
idempotency keys fail closed. Existing per-PR, merge-train, and Goobers
concurrency controls remain the operational lock until a later migration phase.

`npm run contracts:validate` is a blocking CI job and the no-shadow-mode exit
gate. This phase only inventories and validates; it does not alter workflow
behavior or start shadow mode.

## Consequences

- Mutation ownership and contract coverage can be checked without executing
  privileged workflow code.
- Source anchors intentionally fail when a mutation is moved or renamed, forcing
  the inventory to be reviewed with the implementation.
- Later cutover work must preserve the v1 fields and either extend this
  validator or explicitly version the contract.
