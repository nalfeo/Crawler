# Session Handoff: Kickoff verdict + in-chat plan enforcement

## Date

2026-07-05

## Persona

Producer

## Systems touched

agent-personas, docs-tooling, mcp-tooling

## Apples

2🍎 exact

## What Was Done

Updated the top-level session instructions in `AGENTS.md` and `.github/copilot-instructions.md` so new sessions must explicitly say whether an ask is recommended, risky, or not recommended, and must keep plans in session chat unless a human explicitly asks for a file artifact. Extended `.github/skills/producer/SKILL.md` with the same visible verdict/in-chat-plan rule, updated `scripts/agent/producer.ts` so triage results carry and render a verdict, and added `scripts/agent/docs/check-session-instructions.ts` plus `docs:check` wiring to keep the mirrored rules aligned. Added unit coverage for both verdict classification and rendered triage output in `tests/unit/producer.test.ts`. Observed in the real CLI artifact `npm run producer -- --triage "Add a bowling minigame"` — before this change there was no explicit verdict line; after the change the output includes `Verdict: RECOMMENDED — ...`.

## Key Decisions Made

- Treated the request as a docs/tooling governance change, not a gameplay/system change.
- Used identical mirrored bullets in the two top-level instruction files so the new docs check can enforce exact alignment instead of fuzzy text matching.
- Exported `renderTriage()` from `scripts/agent/producer.ts` so user-visible triage output can be unit-tested without shelling out to a subprocess.
- Fixed the unrelated-but-blocking ADR check failure by allowlisting the runtime-generated `coverage/balance-metrics.json` artifact in `scripts/agent/docs/check-adr-consistency.ts`, matching the existing generated-artifact handling style in the docs tooling.

## What's Next / Blockers

No functional blockers remain for this slice. If a future session wants stronger enforcement than instruction mirroring, the next step would be to locate or add the actual automatic session-kickoff integration path so the verdict rule is exercised beyond docs + manual `npm run producer -- --triage`.

## Retrospective

### Lessons Learned

- The repo already had a strong “plans in session” policy down in persona docs; the real gap was top-level prominence plus executable producer output, not the absence of policy entirely.
- The existing docs/tooling pattern is to enforce mirrored governance with small deterministic scripts under `scripts/agent/docs/`; following that pattern kept the change reviewable and easy to validate.
- Exporting a formatter function is a low-friction way to test CLI-visible behavior while keeping the runtime command path simple.

### Mistakes Made

- I initially ran `npm run docs:check` assuming this slice would only touch the new verdict work, but that surfaced an unrelated ADR-path failure. The early signal was `docs-check-adr-consistency` failing on a generated coverage artifact path; I had to stop and repair the baseline before the requested slice could be fully validated.
- I also took the plan-review stage too late in the session. The review correctly pointed out that post-implementation validation still needed user-visible output coverage and full verification discipline.

### Opportunities for Future Improvement

- Add a dedicated docs/tooling test for the review-check scripts themselves so generated-artifact allowlists are less likely to regress silently.
- If session kickoff automation becomes concrete in-repo, add an end-to-end guard or fixture around that path so “verdict at kickoff” is enforced at the real entrypoint, not just in instructions and the Producer CLI.
