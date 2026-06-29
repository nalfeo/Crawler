# Code-review loop (all changes) and multi-model review (>3🍎)

These stages happen **after** you implement and `npm run verify` is green.

## Pick the right review agent(s)

- `code-review` — general correctness, bugs, logic, design. Use on every change.
- `security-review` — when the diff touches input handling, auth, file/network
  I/O, deserialization, or anything trust-sensitive. Add it alongside
  `code-review` for >3🍎 changes by default.

Each agent is stateless — give it the full context (branch, what changed, how to
run things) in the prompt.

---

## Code-review loop (all changes)

Run the appropriate review agent, address feedback, and **loop until no concerns
remain**.

1. Round 1:

   ```
   task(agent_type="code-review", model="claude-sonnet-4.6", name="cr-1",
        prompt="Review the changes on this branch vs main. Focus on real bugs,
                logic errors, and design flaws — skip style/nits. Repo: Crawler.
                Run `git --no-pager diff main...HEAD` to see the diff.")
   ```

2. Address every valid concern (push fixes). Re-run `npm run verify:fast`.

3. If the round surfaced concerns, run **another round** until a round comes back
   with none. The validator requires the **last** round to be `clean:true` with
   `resolved_count >= concerns_count`.

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

> For a 1🍎–3🍎 change this single-model loop is the whole code-review requirement.

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
   requires the **last** round to be `clean:true` with **≥2 distinct models**.

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

## Honesty

If a round keeps surfacing the same valid concern you cannot resolve, **stop and
ask the human** — do not flip `clean` to true or drop the count to escape the
loop (project rule #12). The guard validates structure, not honesty; you own the
honesty.
