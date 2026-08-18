# Handoff — AI progression unblockers

## Systems touched

ai-behavior-tree, hud-ux, ci-policy

## Summary

- Fixed the AI Runner Lab Spell Broker stall by making the auto-driven lab confirm the existing Spell Broker modal only when the deterministic broker intent is active, then marking the intent purchased after the authoritative purchase succeeds.
- Fixed the likely Floor 1→2 browser AI transition stale-state issue by mutating the shared `sceneOptions` object during in-process transition recomposition, matching manual floor switching so post-transition lab automation uses the destination floor callbacks.
- Added focused wiring regressions for Spell Broker modal auto-confirmation and transition scene-options refresh.
- Recovery follow-up: tags the authoritative Spell Broker picker and limits AI confirmation to that identity, so an active broker intent cannot purchase from an unrelated picker; a just-purchased tagged modal is closed safely.
- Completed the 3🍎 review ledger for `ai-progression-unblockers`.

## Files touched

- `src/labs/ai-runner-lab/index.ts`
- `src/shared/modal-picker.ts`
- `src/engine/ModalPickerUI.ts`
- `src/engine/scenes/MainGameScene.ts`
- `tests/unit/ai-shopkeeper-ux-wiring.test.ts`
- `tests/unit/modal-picker.test.ts`
- `tests/unit/ai-runner-run-settings-wiring.test.ts`
- `docs/knowledge/review-ledgers/2026-08-17-ai-progression-unblockers.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-08-17-ai-progression-unblockers.json`

## Verification

- `bash scripts/agent/preflight.sh` ✅
- `npx vitest run tests/unit/ai-shopkeeper-ux-wiring.test.ts tests/unit/ai-runner-run-settings-wiring.test.ts` ✅
- `npm run typecheck` ✅
- `npm run test:headless -- tests/headless/progression-chain.test.ts` ✅
- `npm run verify:fast` ✅
- `npx vitest run tests/unit/modal-picker.test.ts tests/unit/ai-shopkeeper-ux-wiring.test.ts tests/unit/ai-runner-run-settings-wiring.test.ts` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-17-ai-progression-unblockers.review-ledger.json` ✅
- `code_review` ✅ (only noted incomplete independent grade before it was recorded)
- `codeql_checker` ✅ (0 alerts; JS database skipped as too large)
- `npm run sync:main -- --reason pre-publish` ✅

## Observe before done

- Before editing, headless seed 5 already proved the underlying game/AI purchase path can buy the broker spell, while the browser AI Runner Lab modal automation lacked a Spell Broker branch and could require a manual click.
- After editing, the real headless progression artifact still clears Floor 1 into Floor 2 with carryover (`tests/headless/progression-chain.test.ts`), and the AI Runner Lab wiring now confirms the broker modal only for active broker intent and refreshes active scene options during automatic Floor 1→2 transition.
- Recovery follow-up: the real AI Runner Lab boots at `lab.html?lab=ai-runner`; the tagged picker state and lab wiring deterministically prove broker automation cannot act on an untagged shopkeeper modal. Browser-driven capture was unavailable because the Playwright MCP transport closed.

## Unresolved issues

- I did not add a full Playwright AI Runner Lab journey because the existing repo pattern for this lab area is source-level wiring tests and the headless chain already covers real floor progression. A future e2e probe could boot seed 5 in the lab and assert the visual modal closes and Floor 2 starts.

## Recommended next steps

- If this recurs, capture the AI Runner Lab debug snapshot around the broker modal (`window.__aiRunnerDebug()`) and the transition frame to determine whether it is a new modal surface or a scene restart failure.
