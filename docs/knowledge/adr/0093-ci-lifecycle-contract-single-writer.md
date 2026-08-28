# ADR 0093: Versioned CI lifecycle contract and single writer

## Status

Accepted

## Date

2026-08-28

## Estimated Complexity

🍎 x 3 — tooling-only contract and validation across CI Recovery, Merge Train, and Goobers

## Context

CI Recovery, Merge Train, and Goobers each invoke privileged lifecycle mutations.
Their workflow boundaries and state formats must be auditable before a shadow-mode
migration. Existing GitHub concurrency is necessary but does not define a shared
contract or ownership result.

## Decision

`schemas/ci-lifecycle/v1.schema.json` is the interoperability source of truth.
Invocation envelopes bind repository, PR, expected head/base, operation, and
lease identity. State envelopes must report a known phase, status, disposition,
action, and timestamp; successful results are explicitly either `acted` or
`no-op`, never an ambiguous success.

The lifecycle has one authoritative writer: the owning workflow/script listed in
`schemas/ci-lifecycle/inventory.json`. Each mutation uses
`crawler.lifecycle.v1/<repository>/<pr-or-issue>/<headSha>/<operation>` as its
bounded idempotency key. Ownership transitions are
`absent -> acquiring -> held -> renewed -> releasing -> released`, with
`held -> expired -> takeover -> held` permitted only after the existing 30-minute
lease TTL plus five-minute grace window. A different owner fails closed; retrying
the same owner, lease, and key is a no-op. Release requires matching owner,
incarnation, resource, and head SHA.

## Consequences

### Positive

- Workflow mutation paths and delegated scripts have durable file-and-line coverage.
- Independent validation is deterministic, offline, and fail-closed before shadow mode.
- Retry and takeover behavior is explicit and testable.

### Negative

- The inventory must be updated when workflow mutation boundaries move.
- The v1 contract does not itself provide an atomic GitHub compare-and-swap primitive.

### Risks

- A future workflow can bypass the contract unless the CI validation job remains required.
- GitHub API races remain implementation concerns for the later cutover phase.

## Alternatives Considered

- **Separate contracts per workflow:** rejected because it preserves competing writers.
- **External lock service:** rejected; the existing CI Recovery ADR prohibits Azure and
  the phase requires a repository-auditable migration foundation.
