# CI lifecycle mutation inventory

This is the authoritative Phase 0 inventory for the six lifecycle workflows.
The machine-readable rows are in `schemas/ci-lifecycle/inventory.json`; every
row has an owner and a fail-closed guard. The owner is the workflow/script
boundary responsible for preserving the contract. `scripts/agent/ci-contract-validation.mjs`
rejects missing workflows, empty rows, unknown classes, and rows without
file-and-line evidence.

| Workflow                   | Owner                  | Guard                                                                                 |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `ci-recovery-router.yml`   | CI Recovery Router     | same-repository pull-request ingress and unconditional serialized router queue        |
| `ci-recovery.yml`          | CI Recovery            | trusted default-branch checkout, expected head/base fence, per-PR queue               |
| `merge-train.yml`          | Merge Train            | same-repository queue label, default-branch workflow-run filter, serialized reconcile |
| `merge-train-validate.yml` | Merge Train Validation | immutable candidate ref and attestation inputs are required                           |
| `goobers-run.yml`          | Goobers Run            | approved open issue, pinned checksum, explicit token and source validation            |
| `goobers-validate.yml`     | Goobers Validate       | manual-only workflow, pinned checksum, read-only permissions                          |

Mutation classes are intentionally explicit: `dispatch`, `label`, `comment`,
`branch-ref`, `check`, `artifact`, `credential`, and `state`. A workflow row
may name delegated scripts; those calls are mutation boundaries and are not
treated as unowned implementation details.
