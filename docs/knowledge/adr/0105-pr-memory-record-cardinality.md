# ADR 0105: One coordinating handoff and Apple record per PR

- Status: Accepted
- Date: 2026-09-07
- Issue: #4397
- Apples: 3

## Context

Implementation sessions sometimes span multiple turns. Adding a new handoff or
Apple estimate file on each turn creates documentation bloat and increases the
context that later agents must load. The repository already has a PR preflight
guard for the existence of a new handoff, but it did not reject duplicate
branch additions.

## Decision

The PR preflight guard counts files added relative to the branch merge base:

- A non-trivial implementation PR must add exactly one dated handoff.
- A PR may add zero or one dated Apple record. Zero is valid for the existing
  1–2🍎 exception.
- Later turns update the existing handoff and Apple record.
- `docs/knowledge/handoffs/INDEX.md` remains owned by `docs-update.yml`.

Docs-only and dependency-only diffs retain the existing handoff exemption. The
guard uses added-file counts rather than the complete changed-file list so
editing an existing coordinating record remains valid.

## Consequences

The contract is deterministic and reports both duplicate categories in one
preflight response. It prevents multiple coordinating records from entering a
single PR while preserving low-ceremony sessions and multi-turn updates.
Branches that intentionally contain multiple independent implementation efforts
must split those efforts into separate PRs.

## Alternatives considered

- Add a separate checker: rejected because the existing preflight guard already
  owns PR-level handoff and governance checks.
- Count every changed record: rejected because multi-turn work must update the
  original files.
- Require an Apple record for every PR: rejected because the complexity policy
  explicitly waives the record for 1–2🍎 sessions.
