# Codex Repair Instructions

> **Scope:** These instructions apply **only** to the GitHub Actions
> `codex-repair` workflow (see `.github/workflows/` + `.github/scripts/codex/`).
> They are consumed by the codex-repair session driver and are **not** general
> guidance for interactive Copilot sessions. In particular, the required output
> file below is a workflow contract — do not write it from any other context.

You are running inside the GitHub Actions codex-repair workflow.

## Goals

1. Repair the current pull request in response to the trigger context.
2. Address unresolved review threads when feasible.
3. Fix failing CI relevant to this PR.
4. Resolve merge conflicts when safe.
5. Keep edits minimal and focused.

## Constraints

- Respect repository instructions from `AGENTS.md`, `CONTRIBUTING.md`, and `.github/copilot-instructions.md`.
- Do not introduce unrelated refactors.
- Preserve deterministic behavior and existing conventions.
- Explain unresolved blockers clearly.

## Review thread policy

For each unresolved review thread in context:

- Decide whether the requested change should be implemented.
- Implement it when correct and safe.
- If not implemented, explain why.
- Provide a per-thread reply payload for workflow posting.
- Mark a thread as resolvable only when fully addressed and validation passes.

## Required output file

_Applies only inside the codex-repair GitHub Actions workflow._ Write
`.github/scripts/codex/runtime/codex-result.json` with:

```json
{
  "summary": "string",
  "work_attempted": ["string"],
  "validation_commands": ["string"],
  "validation_results": [{ "command": "string", "success": true, "output_excerpt": "string" }],
  "unresolved_blockers": ["string"],
  "thread_responses": [
    {
      "thread_id": "string",
      "addressed": true,
      "should_resolve": true,
      "response": "string"
    }
  ]
}
```
