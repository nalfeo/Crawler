# ADR 0038: Asset-request briefs accept rich multi-sentence text

## Status

Accepted

## Date

2026-07-01

## Estimated Complexity

🍎 x 3 — relaxes a parsing contract consumed by two systems (the sidecar
issue-ingester and downstream brief synthesis); no new lab, but comprehensive
fixture tests and a fingerprint-stability guarantee are required.

## Context

Sprite work is requested by filing a GitHub issue with the `asset-request`
label. The sidecar issue-ingester (`scripts/sprites/sidecar/issue-ingester-controller.ts`)
parses each open issue via `parseAssetRequestIssueBody` in
`scripts/sprites/asset-request.ts` and enqueues a generation job keyed by a
content fingerprint.

The original parser assumed every brief was a single tidy sentence:

- `parseIssueFormBody` captured only the **first line** after `### Brief`
  (`([^\n]+)`).
- `isSingleSentence` then required the text to be 8–240 characters, contain **no
  newline**, end with `.!?`, and hold **exactly one** `[.!?]` character.
- The same `isSingleSentence` gate also validated the machine `asset-request:v1`
  JSON-marker path via `isAssetRequestPayload`.

In practice, authors write rich, multi-sentence, multi-line briefs (character
backstory, tile mood, ability framing). A deterministic sweep of the open queue
found **39 of 65** open `asset-request` issues (exactly #588–#626) were **silently
skipped** — never enqueued — because their `### Brief` was several sentences and
frequently exceeded 240 characters. Only 26 terse single-sentence issues parsed.
The longest legitimate brief observed was ~500 characters.

This is a contract problem, not a data problem: the humans authored valid intent
and the parser discarded it without signal.

## Decision

Relax the brief contract to accept free-form prose, applying the **same**
validation rule to both the issue-form path and the `asset-request:v1`
JSON-marker path so the two contracts stay aligned.

1. **Capture the full `### Brief` section**, not just its first line — everything
   after the heading up to the next `### ` form heading, a trailing
   `<!-- asset-request:v1 -->` marker, or end-of-body. The separator matches only
   the heading's own line terminator so an empty section is rejected rather than
   bleeding into the next section.
2. **Replace `isSingleSentence` with `isValidBriefText`** (honest name, same
   role): allow newlines and multiple sentences; drop the terminal-punctuation
   and exactly-one-terminal requirements. Keep only two guards that matter:
   - a **minimum** normalized length of 8 (rejects empty/garbage), and
   - a **maximum** of 2000 normalized characters, plus a 4000-character raw-input
     cap that runs before whitespace normalization (bounds parse work on the
     verbatim marker path). 2000 is ~4× the longest observed real brief — generous
     for multi-paragraph briefs while still rejecting runaway pastes.
3. **Normalize form briefs to a single clean line** (`trim` + collapse `\s+`)
   before storing. Because `fingerprintAssetRequest` already collapses whitespace,
   this is a **no-op for the 26 previously-valid briefs** — their fingerprints are
   byte-identical, so no already-generated asset is spuriously re-enqueued.
4. **Preserve the marker `briefSentence` verbatim** (no whitespace collapse) so
   the machine contract stays byte-stable; only the shared _validation_ rule is
   applied to it. Reject marker payloads that still contain an unrendered
   `${{ … }}` GitHub Actions template expression, so a failed workflow render
   falls back to the (rendered) issue-form headings instead of enqueuing garbage.
5. **`### Name` and `### Type` handling is unchanged**, including `SPRITE_TYPES`
   validation and the public parse API (`parseAssetRequestIssueBody`,
   `fingerprintAssetRequest`).

The issue template (`.github/ISSUE_TEMPLATE/asset-request.yml`) is updated so its
Brief field description and placeholder invite one-or-more sentences, matching the
relaxed contract.

## Consequences

### Positive

- All 65 open `asset-request` issues now parse (26 → 65); the 39 previously
  skipped issues (#588–#626) enqueue correctly.
- Authors can write natural, descriptive briefs without silent rejection.
- The ingest and marker contracts share one validation rule, removing drift.
- Fingerprint stability is proven, so relaxation does not re-enqueue existing art.

### Negative

- Longer briefs flow verbatim into downstream brief synthesis (`briefHint`),
  slightly increasing prompt size. This is bounded by the 2000-char cap and is
  the intended payload — synthesis already treats the brief as free-form text.

### Risks

- A brief that legitimately contains a Markdown `### ` line would be truncated at
  that boundary. Mitigation: 0 of the 65 real bodies contain an inner `### `; the
  behavior is documented and locked by a unit test.
- The 2000/4000 caps are heuristics. Mitigation: ~4× headroom over observed real
  briefs; caps are named constants with inline rationale and are easy to revisit.

## Alternatives Considered

- **Keep the single-sentence rule; ask authors to shorten briefs.** Rejected: it
  discards authored intent, needs manual triage of 39 issues, and recurs for every
  future rich brief.
- **Only widen the first-line capture (multi-line) but keep length/terminal
  rules.** Rejected: still rejects the many >240-char single-line multi-sentence
  briefs (e.g. #588) and keeps the dishonest `isSingleSentence` name.
- **Store the brief verbatim on the form path too (no whitespace collapse).**
  Rejected: multi-line raw text complicates downstream logging/prompting and would
  change fingerprints for existing briefs unless the fingerprint also stopped
  collapsing — a larger, riskier change. Collapsing keeps fingerprints stable.
