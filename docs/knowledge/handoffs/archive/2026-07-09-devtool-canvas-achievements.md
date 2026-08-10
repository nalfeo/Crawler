# Session Handoff: achievements editor canvas extension (Slice D)

## Date

2026-07-09

## Persona

Producer → Tools/DevEx Engineer (canvas-extension port)

## Systems touched

devtools, quests

## Apples

2🍎 estimated, 2🍎 actual (🎯 on — lowest-coupling slice, no sidecar; the one
structural surprise, per-instance-port localStorage, was caught in plan review
and handled with the pre-sanctioned server-side durable store rather than a
scope expansion).

## What Was Done

Slice D of the DevTool-canvas epic: ports the read/write **achievements editor**
DevTool page (`renderAchievementsEditorPage`, `?page=achievements`,
`DEVTOOLS_PAGE_ACHIEVEMENTS`) into a self-contained canvas extension that lives
**alongside** the untouched 7,600-line monolith (`src/devtools-main.ts`). Reuses
the Slice-A harness (`scripts/canvas-harness/`) via `sync.mjs --to achievements`
— no server/SSE/cache code was reinvented.

- **`.github/extensions/achievements/`** — canvas ext (`extension.mjs` +
  `renderer.mjs` + `lib/` + `tests/`). `createCanvas({ id: 'achievements' })`;
  one loopback `http.createServer` per instance via the vendored
  `startCanvasServer`; the iframe talks only to `127.0.0.1:<port>`. Functional
  parity with `DEVTOOLS_PAGE_ACHIEVEMENTS`: search/filter (id/title/criteria,
  trimmed+lowercased), summary line, two-column list+editor, art-backlog panel,
  and export-JSON panel. Read-only host actions: `list_achievements` (optional
  `query`) + `reload`.
- **Layer-2 domain adapter (`lib/achievements-data.mjs`, no sidecar):** an fs
  reader for `src/shared/data/achievements.floor1.json` that replicates the
  `src/shared/achievements.ts` transforms verbatim (`LOOT_BOX_TIERS`,
  `removeUnlockCriteriaDuplication`, icon-first-seen + tier-ordered
  `buildArtBacklog`). A `.mjs` extension host can't import `.ts`; the README
  sanctions an fs reader (cf. `yaml-reader.mjs`). A companion
  `achievements-data.d.mts` lets the `.ts` parity test import the `.mjs` under
  `tsc` (the tsconfig `include` typechecks `tests/**/*.ts`).
- **Layer-3 pure model (`lib/overrides-model.mjs`):** merge/reward/patch/
  filter/summary/sanitize logic, all **verbatim ports** of the monolith's
  closures — including the invalid-tier → `'common'` normalization
  (`devtools-main.ts:816`) and the six-field trim on save. The iframe imports
  this **same file** over loopback (served by the `GET /lib/overrides-model.mjs`
  binary route), so the browser and the Node unit tests exercise identical code
  — no renderer/logic drift.
- **Override persistence (plan-review blocking fix):** the harness binds each
  instance to a **random `127.0.0.1:0` port**, so origin-scoped `localStorage`
  vanishes on reopen. Added a server-side durable store
  (`lib/overrides-store.mjs`) keyed by repo-root hash under
  `$COPILOT_HOME/extensions/achievements/artifacts/overrides.<sha1(root)[:12]>.json`
  as the source of truth (`GET /api/state` returns it; `PUT /api/overrides`
  writes it). The client **still** mirrors every write to `localStorage` under
  the identical key/shape (`crawler.devtools.achievement-overrides.v1`) — the
  explicitly-requested in-page persistence — and heals a localStorage-only set
  up to the server on load. This strengthens (does not weaken) the parity goal.

**Observed in the real canvas iframe (not a lab):** `extensions_reload` →
`open_canvas({ instanceId: 'achievements-1' })` → live `http://127.0.0.1:<port>/`.

- `list_achievements` → `{ total: 100, overriddenCount: 0, shown: 100 }`;
  `query:'bonk'` → `shown: 1` (first-bonk). Filtering works.
- `GET /api/state` → **100 achievements, 107 art-backlog packs, 7 loot-box tiers
  (`trash,common,uncommon,rare,epic,legendary,divine`), storageKey
  `crawler.devtools.achievement-overrides.v1`**, overrides `[]`.
- `PUT /api/overrides {"first-bonk":{"title":"First Bonk (canvas edit)"}}` →
  `{ ok:true }`; re-`GET /api/state` → override present server-side.
- **Durability across restart:** `extensions_reload` (new pid) → re-`open` (new
  port `58794`) → `GET /api/state` still returned the `first-bonk` override from
  the durable file. Then cleaned up (`PUT {}` → overrides `[]`).
- `GET /lib/overrides-model.mjs` → `200 text/javascript` (binary route serving
  the shared model to the iframe).

**Deterministic side-by-side vs monolith (source-level parity):** the monolith
imports the **same** `FLOOR1_ACHIEVEMENTS` / `ACHIEVEMENT_ART_BACKLOG` /
`LOOT_BOX_TIERS` from `src/shared/achievements.ts` (lines 6–8), uses the **same**
storage key (`devtools-main.ts:552`), and the **same** invalid-tier → `'common'`
save default (`devtools-main.ts:816`). A Vitest parity test
(`tests/unit/devtools/achievements-canvas-adapter-parity.test.ts`) imports the
REAL module and the `.mjs` adapter and deep-compares the catalog, backlog, tiers,
and storage key (4/4 pass).

## Key Decisions Made

- **fs adapter over a TS loader in the extension host** (kept the declared
  architecture). Importing `src/shared/achievements.ts` into the `.mjs` host
  would need a `tsx`/zod loader inside the CLI extension process — risky module
  resolution + a new loader. Instead: read the same JSON, replicate the same
  transforms, and **pin equivalence with a Vitest parity test** that imports the
  real module. Confirmed the JSON is authored in exact zod-schema key order and
  the schema is `.strict()`, so pass-through + flavor transform is byte-identical
  to `FLOOR1_ACHIEVEMENTS` (export dump matches too).
- **Server-side durable store as source of truth, client localStorage as a
  mirror** (plan-review blocking fork). Pure-localStorage parity is broken by the
  harness's per-instance random port (origin changes → storage lost). The
  orchestrator pre-sanctioned a file-backed option; used it as the source of
  truth while preserving the monolith's localStorage write for in-page parity.
- **Fetch-only, no SSE** (plan-review suggestion accepted). The monolith is a
  single page with an explicit "Refresh export JSON" button — a
  server-authoritative fetch + explicit refresh is _more_ faithful than live
  push.
- **Recorded a 2🍎 plan-review ledger even though repo policy exempts 2🍎.** The
  orchestrator explicitly mandated a separate-model plan review + ledger for this
  slice; dropping a required stage would violate rule #12.

## What's Next / Blockers

- **Orchestrator drives the remaining slices.** Do NOT start other tools here.
- **Deferred (non-blocking):** an optional file-backed _export_ of overrides for
  sharing between machines is out of scope — the durable store is per-box under
  `$COPILOT_HOME`, matching the monolith's per-browser localStorage lifetime.
- **Parity gap (none blocking):** the canvas is functionally equivalent, not
  pixel-identical (dark theme via canvas tokens vs the monolith's inline styles).

## Retrospective

### Lessons Learned

- **A `.ts` test importing a sibling `.mjs` fails `tsc --noEmit` (TS2307)**
  because tsconfig `include` covers `tests/**/*.ts` and there's no `allowJs`. Fix:
  ship a companion `*.d.mts` declaration next to the `.mjs`. Vitest transpiles/runs
  the `.mjs` fine without it — the failure is typecheck-only, so it hides until
  full `verify`.
- **`.github/extensions/**`is not eslint-linted but IS prettier
format-checked** — a new`.ts`test under`tests/`must be`prettier --write`'d
or `format:check`(verify step 3) fails. (The`.mjs` files were already
  formatted by authoring.)
- **The harness's random per-instance port breaks origin-scoped `localStorage`.**
  Any canvas that needs to persist user edits must not rely on iframe
  `localStorage` surviving reopen — back it with a durable server-side store.
- **Two-dot `git diff main` is misleading when the branch base is behind main.**
  It showed 1,230 files (all of main's advancement as phantom reverts). The real
  commit surface is `git diff --cached HEAD` (16 files) and the PR three-dot diff
  against `origin/main`.

### Mistakes Made

- Authored the parity `.ts` test and only discovered the `.mjs`-import TS2307 at
  full `verify` (typecheck passes on its own only after the `.d.mts` landed).
  Early signal: any cross-language import from a typechecked `tests/**/*.ts` needs
  a declaration file _before_ the first `verify`.

### Opportunities for Future Improvement

- The `.d.mts` companion is hand-maintained; if more slices import their `.mjs`
  adapters from `.ts` tests, a tiny codegen (or switching parity tests to dynamic
  `import()` with a cast) would remove the drift surface.
- A shared `graceful-degrade` / empty-state panel in the harness would let D and
  future slices avoid re-implementing "no data" rendering.
