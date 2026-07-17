# Code-review loop (≥3🍎) and multi-model review (>3🍎)

These stages happen **after** you implement and `npm run verify:fast` is green.
Full `npm run verify` is not a routine pre-PR requirement; CI owns the full suite
unless a human explicitly requests a local run or targeted diagnosis requires it.

## Pick the right review agent(s)

- `code-review` — general correctness, bugs, logic, design. The core agent for the
  ≥3🍎 code-review loop.
- `security-review` — when the diff touches input handling, auth, file/network
  I/O, deserialization, or anything trust-sensitive. Add it alongside
  `code-review` for >3🍎 changes by default.

Each agent is stateless — give it the full context (branch, what changed, how to
run things) in the prompt.

## Canonical review prompt

Every general code-review invocation must tell the agent to read and follow
`.github/instructions/review.instructions.md` and
`docs/agent-os/personas/reviewer.md`. Those files are the canonical persona and
completeness contract shared with native Copilot pull-request review. Do not copy a
shortened checklist into an invocation: that lets review paths drift.

The harness can explicitly select models with the `task` tool's `model` parameter.
Native GitHub Copilot pull-request review uses GitHub's selected model and does not expose
a repository-controlled model selector, so repository instructions influence its persona
and method, not its underlying model.

Use this prompt for each general reviewer:

```
Review this branch against main. Before reviewing, read and follow
`.github/instructions/review.instructions.md`,
`docs/agent-os/personas/reviewer.md`, and every path-specific instruction that applies
to the changed files. Inspect the complete diff plus relevant callers and tests. Follow
the contract's category matrix and second-pass root-cause search. Return all validated
findings together; do not stop at the first issue or defer discoveries to another round.
Repo: Crawler. Run `git --no-pager diff main...HEAD` to inspect the diff.
```

---

## Code-review loop (≥3🍎)

Run the appropriate review agent, address feedback, and **loop until no concerns
remain**.

1. Round 1:

   ```
   task(agent_type="code-review", model="claude-sonnet-4.6", name="cr-1",
        prompt="<canonical review prompt above>")
   ```

2. Address every valid concern (push fixes). Re-run `npm run verify:fast`.

3. If the round surfaced concerns, run **another round** until a round comes back
   with none. The validator requires the **last** round to be `clean:true` with
   `resolved_count >= concerns_count`. The loop is **bounded at 2 rounds** — if a
   concern is still intractable after round 2, escalate (see "Bounded loop" below)
   instead of looping forever.

4. Record the stage (one entry per round; last round clean):

   ```
   npm run review:ledger -- stage <path> code_review --json \
     '{"clean":true,"rounds":[
        {"round":1,"models":["claude-sonnet-4.6"],"concerns_count":3,"resolved_count":3,"clean":false},
        {"round":2,"models":["claude-sonnet-4.6"],"concerns_count":0,"resolved_count":0,"clean":true}
      ]}'
   ```

   Validator: `clean===true`; ≥1 round; last round `clean===true`, ≥1 model,
   `resolved_count >= concerns_count`.

> For a 3🍎 change this single-model loop is the whole code-review requirement.

---

## Multi-model review + adjudication (only >3🍎)

Run each appropriate review agent across **multiple distinct models**, then a
final reasoning model decides which concerns are valid and the remedy, you
**delegate** the fixes, and you **loop until clean**.

1. Fan out review across models in parallel (one tool block):

   ```
   task(agent_type="code-review", model="claude-sonnet-4.6", name="mcr-sonnet", prompt="<diff review prompt>")
   task(agent_type="code-review", model="gpt-5.3-codex",      name="mcr-codex",  prompt="<diff review prompt>")
   task(agent_type="code-review", model="gemini-3.1-pro-preview", name="mcr-gemini", prompt="<diff review prompt>")
   task(agent_type="security-review", model="gpt-5.4", name="mcr-sec", prompt="<security review prompt>")
   ```

   Give every general reviewer the canonical prompt above. Add trust-boundary context to
   the security-review prompt without weakening or replacing its specialist instructions.

2. Adjudicate. Give a final reasoning model all the raw findings; it decides which
   are valid (de-dupes, rejects false positives) and the right fix for each:

   ```
   task(agent_type="general-purpose", model="gpt-5.4", reasoning_effort="xhigh",
        name="adjudicator",
        prompt="Here are findings from 4 reviewers on <change>:\n<paste all>\n
                For each, decide VALID or INVALID with a reason, and for valid
                ones the concrete remedy. Output a deduped, prioritized fix list.")
   ```

3. **Delegate** the fixes (don't hand-fix silently — the process is the point):

   ```
   task(agent_type="general-purpose", model="claude-sonnet-4.6", name="fixer",
        prompt="Apply these fixes to the Crawler branch: <adjudicated list>.
                Run `npm run verify:fast` after. Report what changed.")
   ```

4. Re-run the fan-out. **Loop** until a round has no valid concerns. The validator
   requires the **last** round to be `clean:true` with **≥2 distinct models**. Like
   the code-review loop this is **bounded at 2 rounds** — escalate after round 2 if a
   valid concern is intractable (see "Bounded loop" below).

5. Record the stage:

   ```
   npm run review:ledger -- stage <path> multi_model_review --json \
     '{"clean":true,"adjudicator_model":"gpt-5.4","rounds":[
        {"round":1,"models":["claude-sonnet-4.6","gpt-5.3-codex","gemini-3.1-pro-preview"],"concerns_count":5,"valid_count":3,"resolved_count":3,"clean":false},
        {"round":2,"models":["claude-sonnet-4.6","gpt-5.3-codex"],"concerns_count":0,"valid_count":0,"resolved_count":0,"clean":true}
      ]}'
   ```

   Validator: `clean===true`; `adjudicator_model` non-empty; ≥1 round; last round
   `clean===true`, **≥2 distinct models**, `valid_count <= concerns_count`,
   `resolved_count >= valid_count`.

---

## Bounded loop — cap at 2 rounds, then escalate to a human

Both loops are **bounded**. If after **≥2 genuinely-attempted rounds** a concern is
intractable (needs a product/architecture call the agents can't make), record a
terminal `escalated_to_human` state instead of looping forever. This is the
sanctioned alternative to the clean terminal — a **recorded terminal state a human
must act on**, never a silent skip.

Rules the validator enforces on an escalated `code_review` / `multi_model_review`:

- `clean` is **`false`** (escalation is NOT clean; `clean:true` + escalation fails).
- **≥2 rounds** (never escalate on round 1); **every** round records `models`
  (≥1 for code_review; ≥2 distinct for multi_model_review) + non-negative-int counts.
- final round is **non-clean** with genuine unresolved concerns
  (`resolved_count < concerns_count` for code_review; `< valid_count` for
  multi_model_review).
- `escalated_to_human` = `{ after_round, reason, unresolved_concerns }`:
  `after_round` int **equal to the final round index** (≥2, nothing follows it),
  `reason` non-empty, `unresolved_concerns` int ≥1.

```
npm run review:ledger -- stage <path> code_review --json \
  '{"clean":false,"rounds":[
     {"round":1,"models":["claude-sonnet-4.6"],"concerns_count":4,"resolved_count":2,"clean":false},
     {"round":2,"models":["gpt-5.3-codex"],"concerns_count":2,"resolved_count":0,"clean":false}
   ],
   "escalated_to_human":{"after_round":2,"reason":"Two concerns require a human architecture decision.","unresolved_concerns":2}}'
```

---

## Honesty

Prefer looping until genuinely clean. If after 2 rounds a valid concern remains
intractable, **escalate to the human** via the `escalated_to_human` terminal state
above — do **not** flip `clean` to true or drop the count to escape the loop
(project rule #12). The guard validates structure, not honesty; you own the
honesty. Escalating is always the correct move over weakening a gate.
