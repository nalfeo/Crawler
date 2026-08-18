# Crawler agent skills index

Skills are focused, reusable playbooks that Copilot's model can pick up mid-session.
Each folder contains a `SKILL.md` (with YAML frontmatter naming the skill and
describing when to invoke it) plus any supporting scripts or templates.

The canonical governance rules these skills implement live in `docs/agent-os/policies/`
(complexity, review-harness, lab-gate, CI, memory) — the skills are the
operational how-to.

## Available skills

| Skill                                                                                     | Purpose                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`asset-pr`](asset-pr/SKILL.md)                                                           | Craft focused asset-only PRs, keep the `sprites:*` / Azure-sidecar pipeline correct, and separate art changes from follow-up wiring.                                                                                 |
| [`chrome-devtools`](chrome-devtools/SKILL.md)                                             | Drive Chrome DevTools MCP for browser automation, screenshots, network capture, and perf profiling of `dev` / `lab` sessions.                                                                                        |
| [`conventional-commit`](conventional-commit/SKILL.md)                                     | Generate commit messages that satisfy `commitlint.config.cjs`.                                                                                                                                                       |
| [`code-review`](code-review/SKILL.md)                                                     | Run context-aware, repository-tailored PR/diff reviews focused on changed systems, runtime risks, and high-confidence actionable findings.                                                                           |
| [`create-architectural-decision-record`](create-architectural-decision-record/SKILL.md)   | Author a new ADR under `docs/knowledge/adr/` (next unused number lives in [ADR index](../../docs/knowledge/adr/README.md)).                                                                                          |
| [`perf-optimizer`](perf-optimizer/SKILL.md)                                               | Hunt gameplay-neutral resource optimizations (frame time, load time, memory) and prove covered headless `RunStats` stay byte-identical via `npm run perf:fingerprint`. Paired with the `perf-optimizer` agent.       |
| [`placeholder-audit`](placeholder-audit/SKILL.md)                                         | Audit and replace placeholder art/data using the deterministic guard scripts.                                                                                                                                        |
| [`playtest-fun-rater`](playtest-fun-rater/SKILL.md)                                       | Structured "is this actually fun?" playtest capture that feeds balance/design handoffs.                                                                                                                              |
| [`playwright-explore-website`](playwright-explore-website/SKILL.md)                       | Explore a running app or lab via Playwright MCP to build up test scenarios.                                                                                                                                          |
| [`playwright-generate-test`](playwright-generate-test/SKILL.md)                           | Emit a Vitest + `playwright` (library, not `@playwright/test`) e2e test file for an explored scenario.                                                                                                               |
| [`pr-shepherd`](pr-shepherd/SKILL.md)                                                     | Diagnose stuck PRs — CI failures, merge conflicts, review threads — and drive them to green.                                                                                                                         |
| [`producer`](producer/SKILL.md)                                                           | Triage a request, decompose multi-system feature work into parallel slices, and drive PRs toward autonomous merge — escalating true gameplay decisions to the human. Default persona for multi-layer/ambiguous work. |
| [`review-harness`](review-harness/SKILL.md)                                               | Run the apple-scaled review harness before opening a PR and append the result to the review ledger; canonical policy: [`review-harness-policy.md`](../../docs/agent-os/policies/review-harness-policy.md).           |
| [`session-kickoff-closeout`](session-kickoff-closeout/SKILL.md)                           | Run Crawler session start/finish ceremony: preflight, persona/handoff/memory lookup, apple estimate, verification, review prereqs, handoff, telemetry, and non-draft publication policy.                             |
| [`security-review`](security-review/SKILL.md)                                             | AI-driven security scan (injection, secrets, auth, crypto, deps, access control, business-logic).                                                                                                                    |
| [`sprite-judge`](sprite-judge/SKILL.md)                                                   | Adjudicate generated sprite variants (deterministic sensors + opt-in VLM judge + eyeball) into an accept/reject/regenerate/escalate verdict before `sprites:approve`. Paired with the `asset-forge` agent.           |
| [`suggest-awesome-github-copilot-skills`](suggest-awesome-github-copilot-skills/SKILL.md) | Recommend candidate skills from `awesome-copilot` based on repo context.                                                                                                                                             |

## Adding a new skill

1. Create `.github/skills/<slug>/SKILL.md` with frontmatter (`name`, `description`, and any `applyTo` scope).
2. Keep the skill focused on **one operational job** — reference the canonical policy doc instead of duplicating rules.
3. Add a row to the table above.
4. If the skill enforces or automates a governance rule, list it in the source-of-truth registry in [`docs/README.md`](../../docs/README.md).
