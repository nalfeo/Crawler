# Lore Contradiction Escalations

This is the escalation register for conflicts between the Lore Bible, its
official sources, and new content proposals. It is intentionally separate from
the canon: an unresolved proposal must never be silently promoted into
`lore-bible.md`.

## Record template

Copy this block for every conflict and leave it in place until the Content
Designer and maintainer resolve it:

```text
### [short contradiction id]
Status: [unresolved]
Claim: [the proposed or conflicting claim]
Source A: [repository-relative path and line/section]
Source B: [repository-relative path and line/section]
Provenance: [why each source is relevant and which content task found the conflict]
Decision owner: Content Designer + maintainer
Resolution: pending
```

There are currently no unresolved contradiction records. A record with
`Status: unresolved` is a hard failure in the docs-update lore gate.
