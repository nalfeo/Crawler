# Session Handoff: Floor 3 — Companion League design (docs-only)

## Date

2026-07-24

## Persona

Producer (design/architecture only — no code)

## Systems touched

enemies, ai-behavior-tree, mapgen, hud-ux, inventory, boss-rooms, quests

## Apples

3🍎 exact (docs-only design session; the Floor 3 build itself is a separate 5🍎 epic)

## What Was Done

Authored the complete Floor 3 design package — **no runtime code, no JSON, no sprites** (a
pure design/spec diff, so the review-harness/ledger guard is exempt). Floor 3 is an IP-safe
monster-taming satire, **"The Companion League"**: the player is an invulnerable, non-combatant
"Wrangler" who commands a party of up to 6 auto-battling **Companions**; only Companions take
damage. Deliverables:

- **ADR** `docs/knowledge/adr/0071-floor3-companion-league.md` — 9 cross-system decisions
  (combat inversion via existing `Invincible` tag; team-tagged Companion ally model generalized
  from Floor 2 follow-AI; species = **affinity × fighting-style** with styles as a bounded
  reusable AI-persona set extending `AI_TYPE`; per-creature leveling/3-stage evolution reusing
  `xpMath`; two-track progression; cross-floor kept-companion slot; party-lock recruiting;
  KO/simultaneous-wipe lose; seeded 6-gym + Final Four win). Indexed in the ADR README
  (by-number row + thematic line + count bump).
- **Game-design doc** `docs/knowledge/game-design/floor3-companion-league.md` — 18 sections: the
  fantasy, IP-safe satirical frame, core loop, **complete 7-affinity effectiveness matrix**
  (original 2-regular ring, deliberately NOT canonical fire/water/plant), **7-style persona
  catalog**, recruiting/party-lock, wild creatures/biomes, overworld layout, two-track
  progression + kept companion, evolution/milestones, KO/lose, Studios/Final Four, seeded boss
  variety, rewards, **14-screen UX inventory**, set-piece manifest, IP-safety statement.
- **Roster doc** `docs/knowledge/game-design/floor3-pet-roster.md` — the full **7×7 grid = 49
  species + 3 signature = 52 species × 3 forms = 156 named forms**, each with original
  baby→adolescent→adult names, affinity, style, role, and innate→adult signature ability pair;
  plus naming system + coverage/balance audit (no dead cells).
- **Spec** `.specify/specs/floor3-companion-league.md` — data schemas (`PetSpeciesDef`,
  `AFFINITY_MATRIX`, `StylePersona` registry, `Companion`/`PartySlot` components,
  `KeptCompanionContract`), win/lose wiring (`floor3ObjectiveTick`), grounded reuse map,
  determinism + test plan (same-seed⇒same-roster), and a **16-slice epic decomposition** with
  apple estimates + dependencies.

Runtime/real-artifact observation: **N/A — design-only session, nothing runnable changed.**
Verification was doc-consistency: audited every inline backticked path in ADR 0071 against disk
(all 6 resolve); confirmed `docs/check-paths.ts` and `check-adr-consistency.ts` scopes; section
cross-references between the four docs verified by heading grep.

## Key Decisions Made

- **Combat inversion reuses the existing `Invincible` tag** (short-circuits
  `src/core/apply-damage.ts`) — zero new damage-gating code. "Defeat a handler" = all their
  Companions KO'd, never handler HP.
- **Two orthogonal axes per creature: affinity × fighting style.** 7 styles = 7 reusable AI
  personas; **5 seed the existing `AI_TYPE`** (`CHASE`/`RANGED`/`LEAPER`), only **2 are net-new**
  (`GUARDIAN`, `SUPPORT`). This bounds AI work to 2 new personas covering all 52 species.
- **Two-track progression (the key design fix):** gems/gold/loot → the player's **persistent**
  cross-floor level + gear (stronger for Floor 4+) via the existing `itemPickupSystem`; combat →
  **floor-scoped** per-creature XP driving evolution. No throwaway per-floor currency.
- **One kept companion** carried to future floors at adult form via a `KeptCompanionContract`
  on the carryover channel (precedent ADR 0064); Floor 4's consumer is out of scope.
- **Seeded boss variety** — 6-of-~10 Studios and 4-of-~7 Final Four picked deterministically via
  `SeededRandom` from the floor seed (hard test: same seed ⇒ identical rosters).
- **Original effectiveness matrix** is a 2-regular ring (each affinity beats the next 2, resists
  the previous 2) — chosen over a canonical elemental wheel specifically for IP-safety.

## What's Next / Blockers

- **Next:** implementation is the 16-slice epic in the spec. Start with slice 1 (affinity matrix
  + species/style data) → slice 2 (damage multiplier hook) → slice 3 (Companion entity + ally AI
  generalization). Each `*System` needs a lab **and** real-pipeline wiring (ADR 0039;
  `npm run check:wired-systems`) — lab-only is insufficient.
- **Blocker (environment, not design):** local `npm install` fails on a registry 404 for
  `find-my-way@9.7.0` (a transitive dep missing from the MS package proxy), so `docs:check` /
  `format:check` could not run locally. Diff is docs-only and both checks were audited by reading
  their source; CI owns the authoritative run.
- **Open design question deferred to implementation:** exact per-form stat numbers and the
  L8/L16/L34 ability tuning are left to the balance slice (16) against the ≥90% win-rate gate —
  intentionally not pinned here to avoid seed cherry-picking.

## Retrospective

### Lessons Learned

- `docs/check-paths.ts` only scans `AGENTS.md`, `README.md`, `.github/copilot-instructions.md`,
  `.github/instructions/*`, and `docs/agent-os/policies/*` — **not** `docs/knowledge/**` or
  `.specify/**`. `check-adr-consistency.ts` separately scans **only** `docs/knowledge/adr/*.md`.
  So forward-looking paths (e.g. a not-yet-created `src/shared/data/floor3/`) are safe in a
  game-design doc or spec, but **every backticked path in an ADR must already exist on disk** —
  keep aspirational paths out of ADRs or fenced in code blocks.
- The interview-first intake genuinely improved the design: four rounds of additive feedback
  (fighting-style axis, seeded boss variety, player progression, cross-floor persistence) each
  reshaped the architecture. Reflecting the bounded ask back before writing paid off.

### Mistakes Made

- Initially assumed the next ADR number from the README's "next number" hint, which was **stale**
  (said 0065 while 0069/0070 already existed). The filename slug — not the README table — is the
  source of truth; confirmed 0071 by listing the directory. Check the actual files, not the hint.
- First drafted the effectiveness matrix leaning on familiar elemental intuitions; caught that
  this drifted toward canonical type charts and re-derived a deliberately original 2-regular ring
  for IP-safety. Watch for IP-adjacency creeping in through "obvious" mechanics.

### Opportunities for Future Improvement

- `check-paths.ts` and `check-adr-consistency.ts` do not validate `.specify/specs/**` or
  `docs/knowledge/game-design/**`. A future tooling session could extend path-checking to specs +
  game-design docs (with an allowlist for intentionally-future paths) so reuse-map references
  can't silently rot.
- The 156-form roster is authored as tables; a future slice could generate the
  `src/shared/data/floor3/` species JSON directly from the roster doc (or invert it — generate the
  doc from data) to keep names and `speciesId`s from diverging once code lands.
