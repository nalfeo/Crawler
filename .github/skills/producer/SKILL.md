---
name: producer
description: >-
  Session-level Producer workflow that triages requests, decomposes feature
  work for parallel execution, and drives PRs toward autonomous merge while
  escalating true gameplay decisions back to the human. Use when asked to
  "triage a request", "decompose a feature", "run the producer", "orchestrate
  slices", "force-publish a PR", or when kicking off any multi-system feature
  work. Covers request classification, persona-mapped slice decomposition,
  dependency grouping, force-publish + auto-merge arming, and release-first cloud handoff.
---

# Producer Skill

Mandatory kickoff handler for all sessions. Triages feature requests, clarifies scope, detects game-design decisions, and delegates slices to specialist personas. Publishes PRs eagerly, then releases their sessions so CI Recovery can assign cloud Copilot.

## Invocation

**Automatic:** Triggered when `create_session(..., kickoff: { prompt: "..." })` is called.

**Manual:** `npm run producer -- --triage "user request text"`

## Triage Classifications

### 1. Feature/Enhancement

"Add bowling minigame", "Implement new boss mechanic"

- Decompose into slices, parallelize independent work
- Escalate if touches game-design (mechanics, balance, progression)

### 2. Bug/Fix

"Player can walk through walls on Floor 2", "Loot dropdown happens twice"

- QA triages root cause, specialist fixes
- No escalation (diagnostic only)

### 3. Chore/Refactor/Infrastructure

"Restructure loot table format", "Upgrade Phaser to 4.2"

- Systems or DevOps owns it, parallelizable
- No escalation (safe changes)

### 4. Investigation/Research

"Why is Floor 2 winrate only 30%?", "Does the current spawn tuning feel good?"

- QA collects data, Game Designer analyzes
- Might spawn follow-up balancing task
- Conditional escalation: if data suggests major change

### 5. Game Balancing

"Reduce player damage scaling by 20%", "Make enemies drop 30% more gold"

- Game Designer + QA, human-gated
- Always escalate (data-driven design decision)
- Flow: baseline metrics → propose change → human review → playtest → iterate

### 6. Debugging

"Player reports crash when picking up 5+ items"

- QA reproduces, specialist diagnoses root
- No escalation (diagnostic)
- Output: root cause + fix approach

---

## Workflow

### Phase 1: TRIAGE

Classify the request, emit a visible verdict, and route appropriately:

- **Verdict is mandatory:** say whether the ask is **RECOMMENDED**, **RISKY**, or
  **NOT RECOMMENDED**, with a short reason before moving on.
- **Plans stay in chat:** when a plan is needed, write the full plan in session
  chat. Do not hide it in repo files unless the human explicitly asks for a
  file artifact.

```
REQUEST TRIAGE
├─ FEATURE/ENHANCEMENT
│  └─ Continue to Phase 2 (Clarify)
├─ BUG/DEBUGGING
│  └─ Route to QA Engineer
├─ CHORE/REFACTOR
│  └─ Route to Systems Engineer
├─ INVESTIGATION
│  └─ Route to QA Engineer + Game Designer
├─ GAME BALANCING
│  └─ ESCALATE → ask human upfront (Phase 1.5)
└─ UNCLEAR
   └─ Ask clarifying questions (Phase 1.5)
```

**Triage Decision Tree:**

```python
def triage(request: str) -> str:
    keywords = {
        'balancing': r'balance|tuning|scale|damage|economy|difficulty|drops|spawn|winrate',
        'investigation': r'investigate|research|understand|why|explore|analyze|metric',
        'debugging': r'crash|bug|error|fail|reproduce|diagnose|broken',
        'feature': r'add|implement|new|create|build|design',
        'chore': r'refactor|restructure|clean|update|upgrade|modernize',
    }

    # Balancing is explicit: must mention balance + numbers/metrics
    if 'balancing' in keywords and re.search(r'\d+%|damage|winrate|playtest', request):
        return 'GAME_BALANCING'

    # Investigation: open-ended exploration
    if score(keywords['investigation'], request) > score(keywords['feature'], request):
        return 'INVESTIGATION'

    # Debugging: specific issue diagnosis
    if score(keywords['debugging'], request) > 0:
        return 'DEBUGGING'

    # Feature, Chore: highest score
    scores = {k: score(v, request) for k, v in keywords.items()}
    return max(scores, key=scores.get)

def score(pattern: str, text: str) -> int:
    return len(re.findall(pattern, text, re.IGNORECASE))
```

**If GAME_BALANCING or UNCLEAR:**
→ Goto Phase 1.5 (Escalate/Clarify)

---

### Phase 1.5: ESCALATE or CLARIFY

**For Game Balancing Requests:**

Present baseline metrics and proposed change, then ask human:

```
🎮 GAME BALANCING REQUEST

Request: "Reduce player damage scaling by 20%"
Type: GAME_BALANCING
Verdict: RISKY — gameplay balance changes need human approval and baseline metrics first
Status: WAITING FOR HUMAN APPROVAL

Current Baseline Metrics:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Floor 1: Win rate 95%, Avg time 12min, Meta: physical 70%
Floor 2: Win rate 48%, Avg time 18min, Meta: physical 85%, magic 15%
Scaling breakpoint: Wave 15 (player 1-shot most enemies)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Proposed Change:
- Player base damage multiplier: 1.0x → 0.85x
- Estimated impact: Win rate -25%, Time +3min, Meta ±5%

Questions for you:
1. Is this the right lever? (alternatives: reduce per-level scaling, cap late-game)
2. Target win rate: 70%? 80%?
3. Acceptable playtime increase: +2min? +5min?

Waiting for your decision...
```

**For Unclear Requests:**

Ask missing context:

```
Q1: "Which game systems does this touch? (mechanics / balance / content / progression)"
Q2: "Who is this for? (new players / speedrunners / challenge seekers)"
Q3: "How do we know it works? (playtime / win rate / player feedback)"
Q4: "Are there gameplay implications? (economy, difficulty curve)"
```

Wait for answers, re-triage if needed.

---

### Phase 2: CLARIFY (For Features)

If triage returned FEATURE/ENHANCEMENT, ask upfront clarifying questions:

```
Verdict: RECOMMENDED — reasonable to plan, but scope needs clarification first
Q1: "Which game systems does this touch? (core / game / engine / content)"
Q2: "What's the success metric? (fun / completion rate / balance / engagement)"
Q3: "Are there gameplay implications? (economy, difficulty, progression)"
Q4: "Who is the target audience? (new / speedrunners / hardcore)"
Q5: "Timeline: Is this urgent or ongoing work?"
```

**Blocker detection:**

- If answer to Q3 involves gameplay changes → Escalate to human (before decomposition)
- If answer to any question is vague → Re-ask or block until clarified
- If all answers are clear → Proceed to Phase 3

---

### Phase 3: DECOMPOSE

Break feature into independent slices:

**Slice Requirements:**

- Each slice ≤3🍎 complexity
- Maps to **one specialist persona**
- Has **no blocking dependencies** on other slices (unless documented)
- Is verifiable and testable independently

**Decomposition Process:**

```
Feature request
  ↓
Identify affected systems (core, game, engine, content, graphics, audio)
  ↓
Group work by persona:
  - Content Designer: Quest/floor/loot logic, UI text
  - Graphics Designer: Sprites, animations, particles
  - Systems Engineer: Physics, core systems, registration
  - Game Designer: Balance, difficulty tuning, playtesting
  - Sound Designer: Audio assets, mixing
  - QA Engineer: Integration tests, playtesting
  ↓
For each group, create slice:
  - Name: "Slice X: [Persona] [What]" (e.g., "Slice A: Content Designer - Bowling scoring")
  - Apple estimate (1-3🍎)
  - Minimal description (one paragraph)
  - List blocking dependencies (if any)
  ↓
Verify independence:
  - Can Slice A proceed without waiting for Slice B? YES → independent
  - If NO → document dependency in slice definition
  ↓
If 2+ slices are independent → Parallelize via cloud sessions
```

**Example: "Add bowling minigame"**

```
Slice A (Content Designer): Scoring rules, win conditions, UI text
  Apple: 2🍎
  Dependencies: None

Slice B (Graphics Designer): Sprites, animations, particles
  Apple: 2🍎
  Dependencies: None

Slice C (Systems Engineer): Physics + registration in game loop
  Apple: 3🍎
  Dependencies: A (needs to know scoring rules)

Slice D (Game Designer): Balance tuning + difficulty testing
  Apple: 2🍎
  Dependencies: A, B, C (all content must be in before tuning)
  Approval gate: HUMAN (playtester feedback + balance call)
```

---

### Phase 4: DELEGATE & PARALLELIZE

For each slice:

1. **Check independence:**
   - If blocked by other slices → mark as WAITING
   - If independent → proceed to spawn

2. **Open cloud session:**

   ```bash
   gh api repos/{owner}/{repo}/actions/workflows/create-cloud-session.yml/dispatches \
     -f name="Slice A: Content Designer" \
     -f persona="content-designer" \
     -f kickoff_prompt="[Slice A description]" \
     -f parent_session="[this session ID]"
   ```

3. **Track slice state:**
   - SPAWNED (session opening)
   - IN_PROGRESS (session active, code being written)
   - PUBLISHED_DETACHED (PR live, owning session released)
   - MERGED (PR merged to main)
   - BLOCKED_UPSTREAM (waiting for dependency)
   - BLOCKED_ON_APPROVAL (waiting for human gate)
   - FAILED (CI/review failure)

4. **For dependent slices:**
   - Automatically start when all upstream slices are MERGED

---

### Phase 5: EAGER PUBLICATION & RELEASE-FIRST CLOUD HANDOFF

**Publication Criteria:**

Publish a ready-for-review PR as soon as ALL of:

- ✅ Required local pre-PR validation is complete
- ✅ No blocking questions (spec is clear)
- ✅ No gameplay escalation (no design approval needed)
- ✅ No vague specs (implementation matches intent)

**Do NOT keep in draft waiting for:**

- CI completion
- Review completion
- Cloud Copilot assignment
- Auto-merge conditions

**Publication Workflow:**

```
Session completes implementation + required local validation
  ↓
Producer checks: Blocking questions or gameplay escal.?
  ├─ YES → Escalate before publication
  └─ NO → Create ready-for-review PR immediately
         ↓
         create_pull_request(..., draft: false)
         ↓
         Leave complete PR body + handoff context
         ↓
         End/release the owning session
         ↓
         CI Recovery assigns cloud Copilot for blockers
         (event-driven, with a 10-minute scheduled backstop)
```

**Example output:**

```
📤 SLICE PUBLICATION

Slice: C (Systems Engineer)
PR: #1227
Status: PUBLISHED_DETACHED

⏱️  Timeline:
  Started: 10 min ago
  Published: now
  Local ownership released: now

☁️ Cloud handoff: awaiting CI Recovery
   Takeover target: within one 10-minute reconciliation cycle
```

---

### Phase 5b: CLOUD OWNERSHIP CONTRACT

- **Release comes first.** An active CLI/cloud session on the head branch can
  prevent a new Copilot assignment, so never wait for cloud confirmation before
  ending the publishing session.
- **Default exception:** keep the session local only when the human explicitly
  requested that before PR publication. Do not infer the exception from task
  complexity, CI state, review activity, or convenience.
- **Takeover signal:** CI Recovery posts the exact blocker task, assigns
  `copilot-swe-agent`, and records automation ownership. The event-driven router
  runs on PR/review/CI changes; its scheduled backstop runs every 10 minutes.
- **Failure signal:** if a blocker-bearing PR remains unclaimed after one
  scheduled cycle, surface the unowned PR instead of silently reviving the
  original local session.

---

### Phase 6: AUTONOMY LOOP

While orchestration is active:

```
Every 5 minutes:
  ├─ Output progress summary (to console + JSON Lines log)
  ├─ Check slice state transitions
  ├─ If upstream slices merged → start downstream slices
  ├─ If blocker detected → report in progress output
  └─ If all slices merged → start convergence

On state change:
  ├─ Log to files/producer-orchestration.jsonl
  ├─ Update parent handoff
  └─ Notify user if action needed

On convergence (all slices merged):
  ├─ Arm parent PR for auto-merge
  ├─ Output final metrics (total time, parallelism win, rework count)
  └─ Hand off to next session
```

**Progress Output Example:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 🎬 PRODUCER ORCHESTRATION STATUS                               │
│ Feature: "Add bowling minigame"                                 │
│ Overall: 60% complete (3/5 slices merged)                       │
│ Parent PR: #1234 | Branch: nalfeo-bowling-minigame              │
│ Session elapsed: 45 min                                          │
└─────────────────────────────────────────────────────────────────┘

SLICE PROGRESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 Slice A: Content Designer (Scoring rules)
    Status: MERGED | PR #1225 | Time: 18 min

🟢 Slice B: Graphics Designer (Sprites)
    Status: MERGED | PR #1226 | Time: 22 min

🟡 Slice C: Systems Engineer (Physics)
    Status: PUBLISHED_DETACHED | PR #1227 | Time: 28 min
    Cloud handoff: awaiting CI Recovery

🔵 Slice D: Game Designer (Balance)
    Status: BLOCKED_UPSTREAM | Waiting for: C
    Start in: ~10 min (once C merges)

NEXT ACTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏱️  Waiting for Slice C cloud recovery/merge
⏱️  Slice D will auto-start once C merged
⏱️  Parent PR will auto-merge once all slices converge
```

---

### Phase 7: CONVERGENCE & LEARNING

All slices merged → Parent PR merges:

```
All slices MERGED
  ↓
Producer checks: Parent PR ready for auto-merge?
  ├─ YES → Arm auto-merge, then release the owning session
  └─ NO → Resolve merge blockers (conflicts, CI, etc.)
    ↓
Parent PR merged
  ↓
Output final handoff:
  ├─ Total wall time
  ├─ Parallelism win (time if serial vs. actual)
  ├─ Rework loops (force-push count)
  ├─ Blockers encountered (and how cloud recovery handled them)
  └─ Lessons learned (for harness improvement)
  ↓
File harness-learning issue if blocker repeated
```

---

## CLI Commands

### `npm run producer -- --triage <request>`

Classify a request and output triage result.

```bash
npm run producer -- --triage "Add a bowling minigame"
```

Expected output includes:

```text
Type: FEATURE
Verdict: RECOMMENDED — A feature request is reasonable to plan, but it still needs scope clarification first.
```

### `npm run producer -- --decompose <request>`

Triage → Clarify → Decompose in one pass (for manual testing).

```bash
npm run producer -- --decompose "Add floor 3 with 2 new enemies"
# Output: Slice breakdown + dependencies + parallelism graph
```

### `npm run producer -- --status`

Show current orchestration status (all slices, progress %).

```bash
npm run producer -- --status
# Output: Progress dashboard (as shown in Phase 6)
```

### `npm run producer -- --shepherd-status --pr <number>`

Query Shepherd watch status for a specific PR.

```bash
npm run producer -- --shepherd-status --pr 1227
# Output: Watch mode, events, estimated merge time
```

### `npm run producer -- --force-publish --pr <number>`

Manually override publication criteria (use with caution).

```bash
npm run producer -- --force-publish --pr 1227
# Result: PR published ready-for-review, owning session released
```

---

## Decision Trees

### Is this a game-design choice?

```
Does the request change:
  - Player damage/health scaling? → YES: escalate
  - Enemy spawn rates or difficulty? → YES: escalate
  - Resource economy (gold/XP/drops)? → YES: escalate
  - Floor progression or player progression? → YES: escalate
  - Core game loop or mechanics? → YES: escalate
  - Cosmetic, UI, or content only? → NO: continue
  - Performance, refactor, or infra? → NO: continue
```

### Can this slice be parallelized?

```
Does Slice B depend on Slice A?
  - YES: Slice B is blocked until Slice A merges
  - NO: Open Slice B in parallel
```

### Should this PR stay in draft or publish?

```
CI passing?                          YES → continue
Blocking questions or unclear spec? NO  → continue
Gameplay escalation needed?         NO  → continue
Review ledger valid for apple tier? YES → continue
  ↓
PUBLISH ready-for-review, leave handoff context, release session
```

---

## Guardrails

- **Refuse vague specs:** If the request has <3 concrete details, ask for clarification.
- **Refuse scope creep:** If decomposition balloons to >8 slices or >12🍎, escalate.
- **Respect gameplay gates:** If any slice touches game-design, require human review.
- **One coordinating handoff:** Single handoff per orchestration, linking all slices.
- **Release-first cloud handoff:** Do not wait for cloud assignment before ending the publishing session.
- **Local ownership is explicit-only:** Keep a published PR local only when the human requested it before publication.
- **Never publish with blocking questions:** Clarify or escalate before creating the ready-for-review PR.

---

## Telemetry & Observability

Producer writes to:

**`files/producer-orchestration.jsonl`** (structured log):

```json
{
  "timestamp": "2026-07-03T13:20:00Z",
  "session_id": "c9f823a3-7004-4188-845a-23e3346474a2",
  "feature": "Add bowling minigame",
  "triage_type": "FEATURE",
  "slice_count": 4,
  "slices": [
    {
      "name": "Slice A",
      "persona": "content-designer",
      "apple_tier": 2,
      "status": "MERGED",
      "pr": 1225,
      "time_minutes": 18,
      "dependencies": []
    }
  ],
  "overall_progress": 0.6,
  "parallelism_win_minutes": 15,
  "cloud_recovery_interventions": 0,
  "blockers": []
}
```

**Parent handoff** (human-readable summary):

- Links all child sessions
- Documents game-design gates
- Records apple score + actuals
- Lists blockers and how cloud recovery handled them
- Captures lessons learned

---

## Related

- Producer persona: `docs/agent-os/personas/producer.md`
- Shepherd skill: `.github/skills/pr-shepherd/SKILL.md`
- Review harness: `.github/skills/review-harness/SKILL.md`
- Complexity policy: `docs/agent-os/policies/complexity-policy.md`
- Cloud sessions: _(planned — `docs/guides/cloud-session-orchestration.md` not yet written)_
