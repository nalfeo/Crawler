# Handoff: PR Release Comment Lab Links

**Date:** 2026-06-22
**Persona:** DevOps Engineer
**Branch:** copilot/add-link-to-ai-runner-lab
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** on target

## Systems touched

devtools, docs-tooling

## What was done

Added lab links to the PR release comment posted by the `deploy.yml` workflow.

**Problem:** The release comment only contained a link to the deployed dev build. Reviewers had no easy path to relevant labs.

**Solution:** The comment now always includes a link to the AI Runner lab, plus a "Related labs" section listing any labs specifically relevant to the PR's changed files.

### Files changed

- **`scripts/agent/pr-lab-links.mjs`** (new) — Node.js helper script.
  - Reads a JSON array of changed file paths from stdin.
  - Outputs a JSON array of relevant lab IDs (excluding `ai-runner`, always shown separately).
  - Three detection passes:
    1. **Direct**: file is under `src/labs/<dir>/` → that lab ID
    2. **Static map**: source path matches a known prefix in `SOURCE_PATH_TO_LABS` → mapped lab IDs
    3. **Import scan**: lab index.ts directly imports the changed file by base name

- **`.github/workflows/deploy.yml`** — "Label and comment on released PRs" step.
  - Calls `gh pr view --json files` per PR to get changed file paths.
  - Pipes them through `pr-lab-links.mjs` to get relevant lab IDs.
  - Builds the comment body with deploy link + AI Runner lab + optional Related labs line.

### Example comment output

```
🚀 Released in [deploy #42](…) → [dev/](…)
🤖 [AI Runner lab](…/lab.html?lab=ai-runner)
🔬 Related labs: [weapons-lab](…/lab.html?lab=weapons-lab), [combat-lab](…/lab.html?lab=combat-lab)
```

## Notes for next agent

- `SOURCE_PATH_TO_LABS` in `pr-lab-links.mjs` is a static map; update it when new systems/labs are added.
- The import scan (pass 3) handles labs not yet in the static map by checking direct `from '.../<basename>'` imports in lab index files. It won't catch barrel-import-only labs (those using `../../core/index.js`); the static map covers those.
- The `$'\n'` syntax in the YAML BODY line is required — a literal newline in a YAML block scalar at column 0 breaks Prettier's YAML parser.
