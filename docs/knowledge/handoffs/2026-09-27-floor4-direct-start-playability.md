# Session Handoff: Floor 4 direct-start playability

## Date

2026-09-27

## Persona

Producer → UX Designer

## Systems touched

mapgen, hud-ux, devtools

## Apples

2🍎 exact

## What Was Done

Fixed the Floor 4 direct-start omission that left the shared XP HUD hidden: `initializeFloor4Scenario` now restores the established `floor1-drops-unlocked` tutorial/progression flag alongside Floor 4's existing feature unlocks. The direct-start baseline already grants and equips automatic abilities, so the change intentionally preserves that baseline and does not add currency, XP, health, damage, teleport, or combat injection.

Added a Floor 4 direct-scene regression that enters the public MainGameScene probe, advances the normal fixed-step simulation, and verifies equipped abilities, a real automatic-activation cooldown stamp, and a visible rendered XP bar. Added the corresponding deterministic scenario assertion. The probe now exposes only the already-observed automatic activation IDs needed for that assertion.

Observed in the real MainGameScene browser artifact — before: a Floor 4 direct start had the XP tutorial gate unset and the XP bar was absent; after: the normal direct-start loadout has automatic activation evidence and the rendered XP bar is visible.

The #4783 deployed report bundle was inaccessible from this environment, so the source-level cause and reproduction were established against current `main`. Its reported missing-abilities symptom was not separately reproducible: current main already supplied Floor 4's direct-start active loadout. No density, Headliner, Green Room/equip, Act 2, scale, art, or lighting tuning changed; no concrete reachability or visibility blocker was found that justified widening this fix.

## Key Decisions Made

- Reused the existing Floor 1 tutorial/progression gate, matching Floor 2, instead of adding a Floor-4-specific HUD bypass. This keeps the shared HUD's onboarding behavior intact while making the direct Floor 4 entry state truthful.
- Kept the production edit floor-specific and idempotent. The direct-start baseline remains its existing level, gear, weapon-skill, and active-ability setup.
- Strengthened the real-scene regression after independent review: equipped IDs alone do not prove automatic fire, while the ability system writes the observed cooldown stamp only after a successful automatic activation.
- Deferred scale and lighting deliberately because the bounded issue had a concrete XP-gate cause and no demonstrated Floor 4 reachability/readability defect requiring a broader visual change.

## Authorizations and Constraints

The user explicitly authorized this implementation in `C:\Users\nalfe\.codex\worktrees\5788\Crawler`: inspect issue #4783 and the stated merged baselines, make the bounded Floor 4 direct-start/XP/ability-HUD fix, run the required real-scene and deterministic validation, commit, push, and publish a ready-for-review PR against `main`. The authorization includes normal automatic combat and ordinary scene controls, but expressly excludes test-only XP/currency/HP grants, teleports, injected damage, synthetic combat/spawns, and changing Floor 4 enemy balance to satisfy a gate. No auto-merge is authorized. After publication, ownership transfers to the merge train / CI Recovery rather than waiting locally for CI or review.

## What's Next / Blockers

Publish the ready-for-review PR, attaching this handoff and the validation/review evidence. The only diagnostic limitation is that the #4783 uploaded bundle could not be fetched in this environment; a future owner with issue-attachment access can compare the deployed build if it needs to reconcile the report's missing-abilities observation. No code blocker remains.

## Retrospective

### Lessons Learned

Floor skips can preserve a progressed combat loadout while omitting a separate tutorial-owned HUD flag. Real MainGameScene probes are valuable here because unit baseline state and rendered affordances are different layers. The pinned Node 22 runtime was required for this worktree; the host's newer Node caused engine incompatibility during dependency setup.

### Mistakes Made

The first regression checked only that actives were equipped. Independent review correctly identified that this would pass even if the automatic ability system never fired. The test was revised before publication to advance the ordinary simulation and read the ability system's post-activation cooldown evidence.

### Opportunities for Future Improvement

Consider a reusable direct-floor-entry contract that checks required progression flags and player-visible affordances together, so future floor skips cannot silently diverge from their intended campaign state. Improving issue-attachment availability in the local agent environment would also make deployed-versus-source investigation less ambiguous.
