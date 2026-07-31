# Handoff — pr-shepherd: one-PR-per-child-session

**Date:** 2026-06-28
**Persona:** Producer
**Apple estimate:** 🍎 (declared); actual 🍎 — docs-only edit, two files.

## Systems touched

ci-policy

## Summary

Reinforced the **one-PR-per-child-session** rule in the `pr-shepherd` skill: the
coordinator delegates _every_ blocker (merge-conflict resolution, rebases,
"quick" CI fixes) to that PR's own shepherd session and never self-fixes in a
temp worktree. The only exception is a child that has tried and genuinely
cannot proceed.

## Files touched

- `.github/skills/pr-shepherd/SKILL.md` — Coordinator mode bullet rewritten.
- `.github/skills/pr-shepherd/references/playbook.md` — Mode A §3 "delegate everything" paragraph added.

## Verification

- Docs/skill-only diff; Prettier ran on commit (clean). No code/tests affected.

## Unresolved issues

- None.

## Next steps

- Continue shepherding loop; #446 (combat→weapon lab merge) delegated to its own session.
