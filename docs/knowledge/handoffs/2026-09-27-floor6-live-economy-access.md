# Session Handoff: Floor 6 Live Economy Access

## Date

2026-09-27

## Persona

Producer → Game Designer; independent read-only reviewer for the final diff.

## Systems touched

mapgen, hud-ux

## Apples

1🍎 exact

## What Was Done

Moved the Floor 6 shared map spawn from the distant ingress to a passable point in the Broadcast Relay room, and reclassified that room as the map spawn room. This gives the player an immediate chance to see, defeat, and collect opening raiders before the Relay loses the build opportunity. Added a real next-wave deployment countdown to the Floor 6 scenario HUD and retained the hidden generic floor timer because Floor 6 has no generic floor-timeout terminal condition.

Observed the published dev build at `?floor=floor6&seed=606`: it started with zero requisitions, no visible drops, no floor countdown, and the Relay already taking damage. The real MainGameScene browser acceptance flow now passes ordinary movement, pointer build/inspect/sell/upgrade controls, plus focused headless release/economy gates.

## Key Decisions Made

- Keep the relevant countdown as the actual wave deployment countdown rather than displaying the shared `60:00` HUD fallback, which Floor 6 does not enforce.
- Derive the relay-room spawn from the authored Broadcast Relay layout and make its RoomGraph role match the actual player spawn.
- Keep all behavior in shared Floor 6 map/scenario initialization; no dev URL, renderer, runner, or test-only gameplay override was added.

## Authorizations and Constraints

The user authorized implementing and publishing the current public dev Floor 6 usability fix, including normal validation, commit, push, and a ready-for-review PR. Scope is limited to the shared Floor 6 playable path: real raider-drop currency, normal controls for build/attack/upgrade/sell/refund, relevant countdown visibility, and preserving the existing no-response Relay-loss outcome. The user explicitly rejects lab-only grants, forced setup, and a special floor-launch path that diverges from direct human, headless, or visual-runner starts. The published dev build is the target; do not wait locally for CI or merge after PR publication.

## What's Next / Blockers

Run `npm run sync:main -- --reason pre-publish`; if it changes HEAD, rerun affected checks. Then run `npm run verify:pr-prereqs`, commit, push, and open a ready-for-review PR. Attach the PR artifact and release ownership; CI Recovery owns any post-publication issue. No code blocker remains.

## Retrospective

### Lessons Learned

The current dev page can differ materially from a direct scene probe even when the latter passes. Opening the published URL exposed the actionable player-path failure: the previous spawn was too remote for the opening wave cadence. The browser acceptance test caught the route assumption that became obsolete once the spawn was corrected.

### Mistakes Made

An earlier assessment treated probe and headless passes as proof that the public dev experience was usable. It was wrong: direct observation showed zero player economy opportunity and no countdown. A first review revision also attempted to reveal the generic floor timer, but independent review correctly found that it would display a cosmetic 60-minute clock without an expiry authority; that change was removed.

### Opportunities for Future Improvement

Add a lightweight public-bootstrap acceptance path that verifies the same human-facing floor start route as the deployed dev page, while retaining shared scenario initialization and avoiding gameplay test hooks. Consider making scenario countdown authority explicit in the shared presentation contract so a generic timer cannot be accidentally displayed for a floor without timeout semantics.
