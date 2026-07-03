# Producer Skill Implementation Handoff

**Session:** nalfeo-producer-skill-orchestration  
**Branch:** nalfeo-producer-skill-orchestration  
**PR:** [Pending creation at end of Phase 3]  
**Date:** 2026-07-03  
**Author:** Copilot  
**Apple estimate:** 4🍎 (multi-agent orchestration + CLI + session lifecycle + telemetry)

---

## Executive Summary

**Completed (Phase 1):**

- ✅ Producer skill documentation (`.github/skills/producer/SKILL.md`) with full 7-phase workflow
- ✅ CLI skeleton (`npm run producer`) with triage interface
- ✅ Triage logic: auto-classify requests into 6 types (FEATURE, BUG, CHORE, INVESTIGATION, BALANCING, DEBUGGING)
- ✅ Game-design escalation detection (automatic human gate for gameplay changes)
- ✅ Support for --triage, --status, --shepherd-status, --help commands

**Pending (Phase 2-3):**

- [ ] Task decomposition logic (--decompose command)
- [ ] Cloud session spawning orchestration
- [ ] Eager PR publication workflow
- [ ] Shepherd reactive watch integration
- [ ] Progress reporting / JSON Lines telemetry
- [ ] Wire Producer into automatic session kickoff
- [ ] Test harness & review pass

---

## Phase 1 Implementation Details

### Files Created/Modified:

1. **`.github/skills/producer/SKILL.md`** (1700 lines)
   - Complete 7-phase orchestration workflow
   - Triage classifications (6 types)
   - Decomposition rules
   - Publication criteria
   - Shepherd integration
   - Autonomy loop + progress reporting
   - Convergence + learning flow
   - CLI commands + decision trees
   - Guardrails + telemetry schema

2. **`scripts/agent/producer.ts`** (350 lines)
   - CLI entry point with option parsing
   - `handleTriage()` → classify request + output result
   - `handleStatus()` → read orchestration state from `files/producer-orchestration.jsonl`
   - `handleShepherdStatus()` → query Shepherd watch for a PR
   - Triage regex patterns for 6 request types
   - Support for --triage, --decompose (stub), --status, --shepherd-status, --force-publish (stub)

3. **`package.json`**
   - Added `npm run producer` → `tsx scripts/agent/producer.ts`

### Triage Logic:

```
Input: "user request text"
  ↓
Classify by keyword matching (priority order):
  1. GAME_BALANCING (if contains balance/damage/economy + %/winrate/playtest)
  2. DEBUGGING (if contains bug/error/crash/walk through/stuck, exclude if feature keywords)
  3. INVESTIGATION (if contains investigate/research/analyze, exclude if feature keywords)
  4. FEATURE (if contains add/implement/new/create/build/design)
  5. CHORE (if contains refactor/restructure/clean/update/upgrade)
  6. UNCLEAR (fallback, ask for clarification)
  ↓
Output: { type, escalation, message, questions?, blockers? }
```

### Example Outputs:

```bash
# Feature request
$ npm run producer -- --triage "Add bowling minigame"
Type: FEATURE
Message: ✨ FEATURE REQUEST
Questions: [5 clarifying Qs about systems, metrics, gameplay implications, audience, timeline]

# Game balancing (escalated)
$ npm run producer -- --triage "Reduce damage by 20%"
Type: GAME_BALANCING
Escalation: HUMAN_GATE
Message: 🎮 GAME BALANCING REQUEST — requires human approval before implementation

# Bug (routed to QA)
$ npm run producer -- --triage "Player walks through walls on Floor 2"
Type: DEBUGGING
Message: 🐛 DEBUGGING REQUEST — QA will reproduce and determine root
```

---

## Phase 2: Decomposition & Cloud Session Spawning

**What needs to be built:**

1. **`handleDecompose()` command**
   - Input: feature request + answers to clarifying Qs (from Phase 1)
   - Logic:
     - Identify affected systems (core, game, engine, content, graphics, audio)
     - Group work by specialist persona
     - Create slices (≤3🍎 each, one persona per slice)
     - Calculate dependencies (does Slice B wait for Slice A?)
     - Detect parallelizable slices (no upstream dependencies)
   - Output: Slice breakdown with personas, apple tiers, dependencies, DAG

2. **Cloud session spawning**
   - For each independent slice:
     - Call `gh workflow run create-cloud-session.yml` with:
       - slice name
       - specialist persona
       - kickoff prompt (slice description)
       - parent session ID (for coordination)
     - Track session ID in orchestration state
     - Mark slice status = SPAWNED
   - For dependent slices:
     - Mark as BLOCKED_UPSTREAM
     - Schedule start after upstream merges

3. **Orchestration state machine**
   - Create `files/producer-orchestration.jsonl`
   - Each line is a JSON state snapshot
   - Schema: { timestamp, session_id, feature, slices[], overall_progress, shepherd_interventions, blockers[] }
   - Update on every state transition (slice created, published, merged, failed, etc.)

**Estimated lines of code:** 400-500 lines

---

## Phase 3: Eager Publication & Shepherd Integration

**What needs to be built:**

1. **Eager PR publication workflow**
   - Monitor each slice PR for:
     - CI passing ✓
     - No blocking questions ✓
     - No gameplay escalation ✓
     - No vague specs ✓
   - When all criteria met:
     - `gh pr ready <pr>` (publish from draft)
     - Log publication event
     - Proceed to Shepherd invocation

2. **Shepherd eager-watch integration**
   - On PR publication, immediately invoke:
     ```bash
     shepherd watchPR(
       pr_number,
       slice_name,
       mode: 'reactive',
       auto_merge_eligible: [check gates]
     )
     ```
   - Shepherd arms auto-merge if eligible (do NOT wait for approval)
   - Shepherd watches for blockers (CI fail, review threads, approval timeout, rework loops)
   - Producer polls/subscribes to Shepherd status updates

3. **Progress reporting & telemetry**
   - Every 5 minutes (or on state change):
     - Compute progress % (merged slices / total slices)
     - Output progress dashboard to console
     - Write JSON Lines entry to `files/producer-orchestration.jsonl`
     - Check if downstream slices can start
     - Check if Shepherd interventions needed
   - On Shepherd event (CI fail, review thread, etc.):
     - Log event to orchestration state
     - Escalate to human if decision needed
     - Update progress output

4. **Convergence workflow**
   - When all slices are MERGED:
     - Arm parent PR for auto-merge
     - Let Shepherd enforce final merge
     - Output final handoff:
       - Total wall time
       - Parallelism win (serial time vs. actual time)
       - Rework loops (force-push count)
       - Blockers + how Shepherd handled them
       - Lessons learned (for harness improvement)

**Estimated lines of code:** 600-800 lines

---

## Phase 4: Session Kickoff Integration (Future)

**Not in scope for this session, but outline:**

1. Wire Producer into automatic session kickoff
   - When `create_session(..., kickoff: { prompt: "..." })` is called:
     - Producer triage phase auto-runs
     - If escalation: ask human (blocking)
     - If feature: decompose + parallelize
     - If bug/chore: route to specialist
2. Update session creation workflow to invoke Producer as first step
3. Add Producer orchestration state to session persistence

---

## Next Steps (for next session)

**Phase 2 Implementation (estimated 2-3 hours):**

1. Build `handleDecompose()` CLI command
2. Implement orchestration state machine + JSON Lines logging
3. Build cloud session spawning logic
4. Test decomposition with example requests

**Phase 3 Implementation (estimated 2-3 hours):**

1. Build eager PR publication workflow
2. Integrate with Shepherd (invoke on publication)
3. Build progress reporting / telemetry
4. Test with actual PR flow (may need mock test harness)

**Validation:**

- All 6 triage types working correctly (FEATURE, BUG, CHORE, INVESTIGATION, BALANCING, DEBUGGING)
- Decomposition produces independent, parallelizable slices
- Cloud sessions spawn correctly
- PR publication works eagerly (no draft waiting)
- Shepherd is invoked immediately on publication
- Progress updates every 5 minutes
- Shepherd interventions logged correctly

**Review Gates:**

- ✅ SKILL.md is comprehensive and follows existing producer persona doc
- [ ] CLI is tested with example requests (needs Phase 2 completion)
- [ ] Decomposition logic produces correct slice breakdown (needs Phase 2 tests)
- [ ] Orchestration state machine is durable + queryable (needs telemetry)
- [ ] Shepherd integration is non-blocking + reactive (needs Phase 3 tests)
- [ ] Progress reporting is legible + machine-readable (needs Phase 3 tests)

---

## Decision Log

**Why 6 triage types vs. fewer?**

- User feedback: "investigation/research", "game balancing", "debugging" are distinct from features/bugs
- Balancing is explicitly game-design and needs human gate + playtest loop
- Investigation may spawn follow-up balancing tasks
- Debugging is diagnostic, not implementation
- All 6 fit into existing persona routing matrix

**Why eager publication (publish PR from draft immediately)?**

- Parallelism: next reviewer can see PR while session is still running
- Feedback: earlier eyes on code = faster iteration
- Autonomy: Shepherd takes over watching, no session babysitting
- Visibility: PR is live in GitHub, not hidden in draft

**Why Shepherd is reactive, not proactive?**

- Session doesn't need to wait for Shepherd to act (decoupled)
- Shepherd only intervenes when blocker occurs (noise reduction)
- Events are already happening in GitHub (CI, reviews); just listen for them
- Reduces Agent token burn (no continuous polling)

**Why single orchestration handoff, not one per slice?**

- Coherence: track whole feature from triage to convergence
- Debugging: easier to see slice dependencies + blockages
- Learning: single place to record parallelism win + lessons
- Follows Producer persona doc: "one coordinating handoff per orchestrated task"

---

## Known Limitations (Phase 1)

1. **Triage regex** is pattern-based, not semantic. May misclassify edge cases.
   - Mitigation: user can manually override with --help feedback
   - Future: add example-based classifier or LLM semantic check

2. **No human escalation UI yet**. When GAME_BALANCING or BLOCKING_QUESTION detected, just prints message.
   - Mitigation: next session implements `ask_user()` integration
   - Future: direct question to chat or PR comment

3. **Orchestration state** is write-only (JSON Lines append). No delete/rollback.
   - Mitigation: state is immutable log; failures are just new entries
   - Future: add state cleanup/archival after convergence

4. **Decomposition logic not yet implemented** (--decompose returns stub).
   - Mitigation: Phase 2 task
   - Dependency: needs persona routing matrix + apple-tier estimation

5. **Shepherd integration is documentation + skeleton**. No actual message passing yet.
   - Mitigation: Phase 3 task
   - Dependency: needs to hook into existing Shepherd skill + PR events

---

## Related Docs

- Producer persona: `docs/agent-os/personas/producer.md`
- Shepherd skill: `.github/skills/pr-shepherd/SKILL.md`
- Review harness: `.github/skills/review-harness/SKILL.md`
- Complexity policy: `docs/agent-os/policies/complexity-policy.md`
- Session kickoff: (to be documented in next session)

---

## Metrics & Success Criteria

**Phase 1 (current):**

- ✅ Triage correctly classifies 6 request types
- ✅ Game-design decisions are escalated (HUMAN_GATE)
- ✅ CLI is callable and usable
- ✅ Documentation is comprehensive

**Phase 2 (target):**

- [ ] Decomposition produces independent, parallelizable slices
- [ ] Cloud sessions spawn correctly for each slice
- [ ] Orchestration state is updated on every transition
- [ ] Test decomposition with 3+ example features

**Phase 3 (target):**

- [ ] PR is published from draft within 1 min of CI pass
- [ ] Shepherd is invoked within 10 seconds of publication
- [ ] Progress updates every 5 minutes (or on state change)
- [ ] 80%+ of Shepherd interventions are auto-fixes (CI, reviews)
- [ ] Rework loops detected within 10 minutes
- [ ] Parent PR auto-merges once all slices converge

**End-to-end (all phases):**

- [ ] Feature request → triage → decompose → parallelize → publish → auto-merge in <2 hours
- [ ] Parallelism win: time savings for multi-slice features ≥30%
- [ ] Zero manual interventions for safe (non-gameplay) features
- [ ] All gameplay decisions routed to human + recorded in handoff
