# Session Handoff: Worktree server status canvas

## Summary

Added a new project canvas extension at `.github/extensions/worktree-server-status/` that discovers live Vite servers for the current Copilot worktree on Windows and renders a polling dashboard with direct links to the game, labs, and devtools routes for the active address/port.

The detector does not rely on session-local launch history. Instead, it:

- captures the session worktree path from SDK hook `workingDirectory`
- scans Windows process metadata for Vite launch commands tied to that worktree
- maps the matching Vite process up to its listening ancestor port
- verifies the discovered base URL by probing `/`, `/lab.html`, and `/devtools.html`
- writes the latest discovery snapshot to the session artifact file `files/worktree-server-status.json`

## Files Touched

- `.github/extensions/worktree-server-status/extension.mjs`
- `.github/extensions/worktree-server-status/renderer.mjs`

## Validation

- Ran `bash scripts/agent/preflight.sh`
- Reloaded extensions and confirmed `project:worktree-server-status` registered successfully
- Verified `list_canvas_capabilities` exposed `refresh` and `get_state`
- Opened the canvas successfully
- Started a temporary `npm run lab -- --host 127.0.0.1 --port 4191` server in this worktree
- Confirmed the canvas detected `http://127.0.0.1:4191` and verified game/labs/devtools routes
- Stopped the temporary server and confirmed the canvas returned to `no active server`

## Notes

- The extension is currently Windows-specific because live discovery uses PowerShell process + TCP inspection.
- `npm run verify:fast` did not complete in this session; it remained stuck in the unit-test phase with Vitest showing `tests/unit/sprites/synthesize-brief.test.ts [queued]` and no further progress, so the hung run was terminated.
