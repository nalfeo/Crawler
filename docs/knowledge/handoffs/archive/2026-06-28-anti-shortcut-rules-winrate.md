# Handoff: Anti-Shortcut Rules + Floor 1 Win-Rate Finding

**Date:** 2026-06-28
**Session:** floor1-winrate-sweep
**Persona:** Producer
**Apples:** 🍎🍎🍎 estimated → 🍎🍎 actual (rules + measurement; root-cause fix deferred)

## Summary

Added two agent rules and measured the real Floor 1 win rate.

- **Rules** (`AGENTS.md`, `.github/copilot-instructions.md`): never silently weaken
  an explicit human requirement; never bend gameplay or cherry-pick seeds to pass
  the gate — target 90%+ Floor 1 win rate, below that = AI-runner bug/regression.
- **Sweep** (sword, seeds 1–40, 360s budget): **75% (30/40)**. Fails: 8 death@288 L5,
  12 death@358 L4, 17/18/24/28/31 timeout@367, 21 death@96 L0, 29 timeout@367 L0,
  36 victory@365 (over budget). bow/bat expected lower.

## Read

A tight cluster finishes ~365–367s (just over budget) and two L0 seeds never engage
(stuck). Suggests traversal/nav inefficiency — possibly the welcome-office ~5-hop
distance lengthening runs — plus an AI-stuck class. The current gate's hand-picked
4 seeds mask this.

## Next steps

- Dedicated session: drive sword/bow/bat win rate to 90%+ (root cause: AI nav
  budget vs welcome distance; L0 stuck), then redesign the gate around a sampled
  win-rate, not cherry-picked seeds.

## Verification

- verify:fast green pre-change; rules are docs-only.
