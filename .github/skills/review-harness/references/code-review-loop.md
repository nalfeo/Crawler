# Post-diff code review

Run reviews only after the implementation diff and focused tests are ready.

## Counts

- 1–2🍎: no independent review requirement; tests and CI only.
- 3🍎: one independent review.
- 4–5🍎: two independent reviews using distinct reviewer contexts and, where
  selectable, distinct models.

Each reviewer must read `.github/instructions/review.instructions.md` and
`docs/agent-os/personas/reviewer.md`, inspect the complete diff plus relevant
callers and tests, and return all high-confidence findings together.

For model-selectable local reviews, use the `task` tool's `model` parameter and
the same canonical review contract:

```text
task(agent_type="code-review", model="<independent model>", prompt="<canonical review prompt above>")
```

Native GitHub Copilot pull-request review uses GitHub's selected model and the
same repository review instructions. For a two-review tier, do not count a
second pass from the same reviewer context as an independent review.

Address valid findings and rerun affected tests. If fixes materially change the
diff, request a fresh review of the new head. Escalate substantive disagreement
to the human; never relabel a valid concern merely to make the change look clean.

For published work, GitHub reviews and review threads are the only review audit
trail. Reply and resolve in the exact thread; do not mirror outcomes into files.
