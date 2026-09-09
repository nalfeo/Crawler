# Floor 4 Green Room merchant repass

## Verdict

Recommended. The authoritative purchase helper already existed, and the
remaining defect was the missing production adapter plus incomplete economy
telemetry.

## Apple estimate

3🍎 estimated; implementation remained within the existing Floor 4 merchant
surface and shared economy contracts.

## Systems touched

floor4-green-room, main-game-scene, shop-panel, gold-economy, headless-runner

## Change

The real MainGameScene now opens the shared shop panel when the player first
interacts with an intermission Green Room marker. The bootstrap supplies
manifest-backed offers and routes purchases to `purchaseFloor4GreenRoomOffer`.
Successful and unaffordable Green Room transactions now record vendor visits,
decisions, spent gold, and purchase counts in the same ledger consumed by
headless `goldEconomy` reporting.

## Verification

`npm run typecheck`; focused Floor 4 unit tests (30 passed); `bash
scripts/agent/verify-fast.sh` (4123 tests passed and fast verification passed).

## Risk

The panel reuses the existing shared merchant UI and the purchase helper
remains the sole wallet/inventory mutation path. The residual risk is limited
to browser interaction timing around the two-step Green Room flow; the
intermission marker and scenario authority remain unchanged.
