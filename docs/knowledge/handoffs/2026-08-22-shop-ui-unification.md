# Session Handoff: Unify merchant shop UIs on a shared base

## Date

2026-08-22

## Persona

UX Designer

## Systems touched

hud-ux, inventory, quests

## Apples

3🍎 estimated, 3🍎 actual (on target — the four merchant flows were the whole
scope, and the only surprise was needing a probe-lab affordance to observe the
Floor-1 modal in the real scene).

## What Was Done

Issue #3277: every merchant had its own UX surface. `QuartermasterUI` was a
config-driven panel (Floor-2 Quartermaster + settlement shops), while three
`ModalPickerUI` configs were hand-built inline in `MainGameScene` (Floor-1
shopkeeper quest ware, Floor-1 post-quest wares, Floor-1 Spell Broker). Each
re-invented price formatting, gold display, affordability wording, and
purchase-failure hints.

Introduced one shared shop system in `src/engine/shop/`:

- `shop-offer-model.ts` — pure, Phaser-free offer model with a single
  discriminated `ShopOfferAvailability` (`available` / `sold-out` / `owned` /
  `insufficient-gold` / `unavailable`) and all shared wording
  (`formatShopPrice`, `formatShopGoldLine`, `formatShopOfferLabel`,
  `describeShopOfferStatus`, `describeShopPurchaseFailure`). It is
  presentation-only: it never re-derives eligibility, so authoritative purchase
  logic stays in `src/core/quartermaster-purchase.ts`,
  `src/core/settlement-shop-purchase.ts`, and the scene options.
- `shop-modal-presenter.ts` — `buildShopModalConfig` (pure) + `openShopModal`,
  with an explicit `whenNothingPurchasable` policy (`decline` |
  `open-disabled`).
- `ShopPanelUI.ts` — the former `src/engine/QuartermasterUI.ts`, moved/renamed
  and now deriving row labels, prices, sold-out text, and the gold line from
  the shared model.

All four flows now route through this system; adding a merchant means supplying
`ShopOffer[]` and picking a surface.

Observed in the real artifact (not a lab): the new e2e
`tests/e2e/floor1-merchant-modal.test.ts` drives the real `MainGameScene`
Floor-1 shopkeeper through the real `ModalPickerUI`. Before: an unaffordable
ware rendered as an **enabled** row reading `Need 60 more gold` with a
`Gold: 0` subtitle. After: a **disabled** row reading
`Merchant's Magic Charm (60g)` with the shared `Not enough gold.` status and a
`Gold: 0g` subtitle — confirmed by screenshot and asserted deterministically in
the e2e. `tests/e2e/main-game-scene-quartermaster.test.ts` (16 tests) still
passes unchanged, proving the panel surface is behavior-identical.

## Key Decisions Made

- **Two surfaces, one contract.** Dialogue merchants stay on `ModalPickerUI`;
  stock-heavy shops stay on the panel. Collapsing Floor-1 merchants into the
  panel would have broken player flow, the `kind: 'spell-broker'` AI automation
  contract (`src/labs/ai-runner-lab` reads `modalPicker.getKind()`), and
  existing e2e expectations. Unification is of the _model and wording_, not of
  the renderer.
- **Per-flow empty behavior is explicit, not blanket.** `whenNothingPurchasable`
  preserves each flow: quest ware still opens disabled when the player can't
  afford it, while post-quest stock and the Spell Broker still decline so the
  dialogue continues.
- **One deliberate player-visible change** was accepted for consistency: the
  unaffordable modal row moved from an enabled `Need N more gold` option to a
  disabled `Name (Ng)` row with `Not enough gold.`, matching the panel. Gold
  subtitles unified to `Gold: Ng`.
- **Availability is a single discriminated state**, not overlapping booleans —
  a plan-review concern that was adopted before any code was written.
- `getContentSnapshot()` on `ModalPickerUI` exists so modal text can be asserted
  deterministically instead of via pixel diffing or an LLM judge.

## What's Next / Blockers

No blockers. Natural follow-ups:

- A future merchant (e.g. a Floor-3 vendor) should be the first consumer that
  writes no bespoke wording — treat that as the real test of extensibility.
- If a second modal merchant ever needs AI automation, give it a `kind` then;
  the two unnamed merchant modals were deliberately left without one so no new
  automation contract is created by accident.

## Retrospective

### Lessons Learned

- Playwright browsers are **not** pre-installed in this sandbox;
  `npx playwright install chromium` is required before any e2e run. The e2e
  project self-spawns the Vite lab server via `tests/e2e/global-setup.ts`, so no
  manual server management is needed.
- Rule #9 is satisfiable cheaply by adding a probe-lab affordance that primes
  real world state (`primeShopkeeperPurchase` sets the goal flag, gold, and
  proximity) and then calling the existing `queueInteraction()` — the real scene
  opens the real modal, so it is genuinely not lab-only validation.
- Doing the separate-model plan review _before_ writing code paid for itself:
  the discriminated-availability and preserve-per-flow-empty-behavior concerns
  would both have been expensive to retrofit.

### Mistakes Made

- Initially planned a blanket "decline when nothing is purchasable" policy,
  which would have silently changed the Floor-1 quest-ware flow (it previously
  opened even when unaffordable). Early signal: three call sites with
  _different_ existing empty-state behavior is a sign you need a policy
  parameter, not a default.
- Wrote a throwaway screenshot spec (`tests/e2e/tmp-merchant-shot.test.ts`)
  inside the repo instead of `/tmp`, and had to remember to delete it before
  committing. Put scratch harnesses in `/tmp` from the start.

### Opportunities for Future Improvement

- `MainGameScene.ts` is still the wiring hub for all three modal merchants;
  extracting each merchant's offer construction into a small per-merchant module
  would shrink the scene further without changing behavior.
- A deterministic check that no new `ModalPickerUI` config is hand-built with
  gold/price strings outside `src/engine/shop/` would keep this consolidation
  from eroding — currently it is convention, not a gate.
