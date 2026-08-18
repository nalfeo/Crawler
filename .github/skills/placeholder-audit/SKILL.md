---
name: placeholder-audit
description: >-
  Deterministically find placeholders that a real generated asset could now
  replace. Use after new sprite art lands (a sprite PR merged, a brief
  approved, the manifest changed) or before wiring a concept, when asked to
  "audit placeholders", "find replaceable placeholders", "what placeholders can
  I retire", or "did this new art unblock anything". Runs
  `npm run sprites:placeholder-audit`, which scans the generated manifest, the
  engine sprite registry, and the mob defs, collapses every name to a bare
  concept, and reports which placeholders now have real art available.
---

# Placeholder Audit

After new art lands the project still carries placeholders that the new asset
could replace, but nothing auto-wires them: a real generated asset ships under a
versioned brief id (`slime-queen`) while the placeholder it should replace is
the bare concept (`slime-queen`), so the names never match by string. This skill
surfaces that gap deterministically.

> The deterministic work — loading the manifest, reading the sprite registry and
> mob defs, optionally diffing against a git ref, normalizing names, and
> bucketing the results — is done by `npm run sprites:placeholder-audit`
> (`scripts/sprites/placeholder-audit-cli.ts`). The pure logic lives in
> `scripts/sprites/placeholder-audit.ts` and is unit-tested in
> `tests/unit/sprites/placeholder-audit.test.ts`. This is a read-only report; it
> never edits code or wires anything.

## When to run

- **After new art lands** — a sprite PR merged, a brief was approved, or
  `public/assets/generated/manifest.json` changed. Run with
  `--since main` (or `--since HEAD~1`) to see only what the new art unblocked.
- **Before wiring a concept** — confirm a real asset actually exists for the
  placeholder you are about to replace, and check the heuristic name links for
  near-matches you might otherwise miss.
- **As a CI/pre-merge guard** — add `--fail-on-replaceable` so the command exits
  non-zero when a placeholder could already be replaced (scoped to newly
  replaceable concepts when `--since` is set).

## The three placeholder sources

The audit scans exactly these, so the report covers every placeholder the game
can show:

1. **Generated manifest** — entries whose `sourceRun` or `sensorScore` is
   `"placeholder"`, or whose `assetPath` ends in `-placeholder.png`. These back
   item icons (an item resolves its sprite by `itemId === briefId`).
2. **Engine sprite registry** (`SPRITES`) — temp CC0 Kenney frames whose `note`
   says "temp CC0 art" (for example `enemy.slime`, `enemy.rat`).
3. **Mob defs** — any mob whose `spriteId` is the shared generic
   `mob-placeholder`.

Every name (manifest brief id, sprite id, mob id) is normalized to a bare
concept: dotted `enemy.`/`npc.`/`item.` prefixes are dropped and the
`-var-N`, `-vN`, and `-placeholder` suffixes are stripped, so a placeholder and
its real `-v1` asset collapse to one concept.

## Flags

- `--since <git-ref>` — scope to real assets added since `<ref>` (for example
  `main`, `HEAD~1`). Those assets are flagged new (`*` in table output) and the
  replaceable / new-content sections are narrowed to concepts touching them.
- `--format <table|json>` — output mode. `table` (default) is the human report;
  `json` emits the full `PlaceholderAuditReport` for scripting.
- `--all` — in table mode, also list every still-on-placeholder concept instead
  of just the count.
- `--fail-on-replaceable` — exit non-zero when a replaceable placeholder exists
  (with `--since`, only newly replaceable ones). Useful as a gate.
- `--manifest <path>` — override the manifest path
  (default `public/assets/generated/manifest.json`).
- `--help`, `-h` — show usage.

```bash
# Full picture
npm run sprites:placeholder-audit

# Only what the latest art unblocked
npm run sprites:placeholder-audit -- --since main

# Machine-readable, scoped to the last commit
npm run sprites:placeholder-audit -- --since HEAD~1 --format json
```

## How to read the report

- **Replaceable now** — a current placeholder AND a real asset share a concept.
  These are the actionable rows: the art exists, so wire the real asset and
  retire the placeholder. (With `--since`, only concepts touching a new asset.)
- **New real assets / new content** — a real asset with no matching placeholder.
  Either genuinely new content, or a concept whose placeholder lives under a name
  the normalizer did not collapse — scan the related suggestions before assuming
  it is brand new.
- **Related name suggestions (heuristic)** — a placeholder concept and a real
  concept where one is a hyphen-prefix of the other (for example `slime` ~>
  `slime-queen`). These are **suggestions only**: the names merely share a stem,
  they do not collapse to an identical concept. Verify the art truly fits the
  placeholder before wiring it.
- **Still on placeholder** — concepts with a placeholder and no real art yet;
  these still need a brief. Shown as a count by default; pass `--all` (or use
  `--format json`) for the full list.

The `Totals:` line summarizes counts; in `--since` mode a `*` marks each asset
added since the ref.

## Guardrails

- **Read-only.** This skill reports; it never edits manifests, sprite defs, or
  mob defs. Wiring a replacement is a separate, deliberate change.
- **Suggestions are heuristic.** Treat the related-name section as leads to
  verify, never as authoritative matches.
- If the bucketing looks wrong, fix the pure logic in
  `scripts/sprites/placeholder-audit.ts` and extend
  `tests/unit/sprites/placeholder-audit.test.ts` — do not special-case the CLI.
