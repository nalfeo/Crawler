# RPG inventory UX lookbook recovery

## Systems touched

inventory, mcp-tooling, agent-personas

## Summary

Recovered the RPG inventory UX lookbook from the session attachment into
repo-owned durable references without committing the screenshot-heavy PDF. The
PDF contains third-party game screenshots, so the durable repo copy is the
extracted design analysis, constraints, and rubric rather than the original
image document.

Added:

- `docs/knowledge/game-design/rpg-inventory-ux-lookbook.md` — human-readable
  extracted lookbook for equipment/inventory UX, including the core test,
  principles, pixel PC playbook, text-safety rules, failure modes, product
  constraints, and usability test.
- `scripts/agent/review/rpg-inventory-ux-lookbook-rubric.json` — compact
  machine-readable rubric used by the visual-review judge prompt.

Wired:

- `scripts/agent/review/visual-review-agent.ts` now loads the checked-in rubric
  at runtime and injects it into the prompt for equipment, inventory,
  item-tooltip, loot-triage, and build-inspection surfaces.
- `.github/agents/ux-designer.agent.md` now explicitly tells UX Designer agents
  to read the checked-in lookbook for equipment/inventory/item-tooltip work
  rather than relying on session-local attachments.
- `.github/skills/visual-review/SKILL.md` and `docs/guides/visual-review-process.md`
  now document the lookbook/rubric source paths.

## Why the original PDF is not checked in

The supplied lookbook has useful original design analysis, but its visual pages
embed reference screenshots from many commercial games. To keep the project
usable by the judge/designer agents without creating a repo-owned copy of those
third-party images, the durable artifact is text/config extraction only.

## Verification

- JSON parse check for `scripts/agent/review/rpg-inventory-ux-lookbook-rubric.json`.
- `npm run typecheck -- --pretty false`.
- `npm run verify:fast`.

## Notes

Preflight attempted to sync with `main`, but `sync:main` hit a rebase conflict
on the existing equipment UX branch and aborted cleanly. No conflict state was
left in the worktree. Dependency validation initially found `tsc` missing from
the local install; `npm ci` was blocked by a Windows file lock on Rolldown's
native binding, so the exact existing TypeScript devDependency was restored with
`npm install --no-save typescript@6.0.3` before verification.
