# Handoff: shock-baton weapon brief (Floor 2 equipment icon)

**Date:** 2026-07-18  
**Agent:** Graphics Designer  
**Apple estimate:** 1🍎  
**Issue:** Closes #1469

## Summary

Authored `briefs/weapons/shock-baton.yaml` for the Floor 2 equipment icon request. This is a pure art/brief task (no gameplay/runtime code changes).

## Systems touched

sprite-workflow

## Files changed

- `briefs/weapons/shock-baton.yaml` — new weapon brief for the shock baton icon
- `docs/knowledge/handoffs/2026-07-18-shock-baton-brief.md` — this handoff

## Design decisions

- **Preserved runtime key contract via brief name:** `name: shock-baton` keeps the canonical item/brief identity aligned for downstream `equipment/weapon/shock-baton` wiring.
- **Kept default weapon orientation/anchor behavior:** issue asks for centered, silhouette-readable output; weapon defaults already enforce centered vertical constraints.
- **Constrained effect intensity:** only minimal electric accent at the emitter tip so the icon remains silhouette-first at slot scale.
- **`minVariations: 6` with two seed variants:** enough controlled diversity without drifting from the core “compact shock baton” shape.

## Verification

- `npm run verify:fast`

## Notes / blockers

- Attempted to post the required pre-implementation plan comment to issue #1469, but this environment cannot currently write issue comments (GitHub API responses: GraphQL 403 and REST blocked by DNS monitoring proxy). The same full plan was prepared and is preserved in session logs.
