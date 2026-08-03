# Producer Skill Implementation Handoff

**Session:** nalfeo-producer-skill-orchestration  
**Branch:** nalfeo-producer-skill-orchestration  
**PR:** [Pending creation at end of Phase 3]  
**Date:** 2026-07-03  
**Author:** Copilot  
**Apple estimate:** 4🍎 (multi-agent orchestration + CLI + session lifecycle + telemetry)

---

## Executive Summary

**Completed (Phase 1 + Phase 2):**

- ✅ Producer skill documentation (`.github/skills/producer/SKILL.md`) with full 7-phase workflow
- ✅ Full CLI (`npm run producer`) implementing all five commands
- ✅ Triage logic: auto-classify requests into 6 types (FEATURE, BUG, CHORE, INVESTIGATION, BALANCING, DEBUGGING)
- ✅ Game-design escalation detection (automatic human gate for gameplay changes)
- ✅ Task decomposition (`--decompose`): systems analysis, persona mapping, slice creation, dependency grouping, parallelizable group computation
- ✅ Eager PR publication workflow (`--force-publish`): publishes draft → arms `--auto --squash` → logs event
- ✅ Shepherd status (`--shepherd-status --pr <n>`): live PR metadata and check state via `gh pr view`
- ✅ Orchestration state machine: JSON Lines telemetry to `files/producer-orchestration.jsonl`
- ✅ Support for `--triage`, `--decompose`, `--status`, `--shepherd-status`, `--force-publish`, `--help`

**Pending (Phase 3+):**

- [ ] Cloud session spawning orchestration (spawn specialist sessions per slice)
- [ ] Wire Producer into automatic session kickoff
- [ ] Convergence workflow (parent PR auto-merge on all slices merged)

---

## Phase 1+2 Implementation Details

### Files Created/Modified:

1. **`.github/skills/producer/SKILL.md`** (~1700 lines)
   - Complete 7-phase orchestration workflow
   - Triage classifications (6 types)
   - Decomposition rules
   - Publication criteria
   - Shepherd integration
   - Autonomy loop + progress reporting
   - Convergence + learning flow
   - CLI commands + decision trees
   - Guardrails + telemetry schema

2. **`scripts/agent/producer.ts`** (843 lines)
   - CLI entry point with option parsing
   - `handleTriage()` → classify request + output result
   - `handleDecompose()` → system analysis, persona mapping, slice creation, dependency grouping, parallel group computation, JSONL state write
   - `handleStatus()` → read + render orchestration state from `files/producer-orchestration.jsonl`
   - `handleShepherdStatus()` → query live PR metadata/check state via `gh pr view`
   - `handleForcePublish()` → publish draft PR, arm `--auto --squash`, log events
   - Triage regex patterns for 6 request types
   - Orchestration JSONL telemetry schema (state + events)

3. **`package.json`**
   - Added `npm run producer` → `tsx scripts/agent/producer.ts`

### Triage Logic:

```
Input: "user request text"
  ↓
Classify by keyword matching (priority order):
  1. GAME_BALANCING (if contains balance/tuning/economy/difficulty/drops/spawn + %/winrate/playtest)
  2. DEBUGGING (if contains bug/error/crash/walk through/stuck, exclude if feature keywords)
  3. INVESTIGATION (if contains investigate/research/analyze, exclude if feature keywords)
  4. FEATURE (if contains add/implement/new/create/build/design)
  5. CHORE (if contains refactor/restructure/clean/update/upgrade)
  6. UNCLEAR (fallback, ask for clarification)
  ↓
Output: { type, escalation, message, questions?, blockers? }
```

### Decomposition Logic:

```
Input: "feature request text"
  ↓
System analysis: keyword match → systemsInvolved[]
  ↓
Persona mapping: systems → personaWork{persona → [systems]}
  ↓
Slice creation: one slice per persona (apples: 2 if ≤2 systems, else 3)
  ↓
Dependency grouping: UI/graphics/audio depend on core (Game Designer, Systems Engineer) slices
  ↓
Parallelizable groups: slices with identical dependency arrays run in parallel
  ↓
Root nodes (zero deps): collected as entry-point set for DAG traversal
  ↓
Output: DecompositionResult { slices, totalApples, criticalPath, parallelizableGroups }
```

### Example Outputs:

```bash
# Feature request
$ npm run producer -- --triage "Add bowling minigame"
Type: FEATURE
Message: ✨ FEATURE REQUEST
Questions: [5 clarifying Qs about systems, metrics, gameplay implications, audience, timeline]

# Game balancing (escalated)
$ npm run producer -- --triage "Reduce winrate by 20%"
Type: GAME_BALANCING
Escalation: HUMAN_GATE
Message: 🎮 GAME BALANCING REQUEST — requires human approval before implementation

# Bug (routed to QA)
$ npm run producer -- --triage "Player walks through walls on Floor 2"
Type: DEBUGGING
Message: 🐛 DEBUGGING REQUEST — QA will reproduce and determine root cause

# Decompose a feature
$ npm run producer -- --decompose "Add loot drop animations and sound effects"
# → Slices: Game Designer (loot), Graphics Designer (graphics), Sound Designer (audio)
# → Dependencies: graphics+audio wait for Game Designer slice
# → Writes state to files/producer-orchestration.jsonl

# Force-publish a PR
$ npm run producer -- --force-publish --pr 1234
# → gh pr ready 1234
# → gh pr merge --auto --squash 1234
# → Logs force_publish_requested + auto_merge_armed events
```

---

## Phase 3: Cloud Session Spawning (Future)

**What needs to be built:**

1. `gh workflow run create-cloud-session.yml` invocation per independent slice
2. Session ID tracking in orchestration state
3. Dependent-slice unblocking on upstream MERGED events

**Estimated lines of code:** 150-200 additional lines

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

**Phase 3 Implementation:**

1. Cloud session spawning for each independent slice
2. Dependent-slice lifecycle (BLOCKED_UPSTREAM → auto-start after upstream MERGED)
3. Full convergence workflow (parent PR auto-merge when all slices converge)

**Validation:**

- All 6 triage types working correctly ✅
- Decomposition produces independent, parallelizable slices ✅
- Force-publish and Shepherd handoff work ✅
- Cloud sessions spawn correctly (Phase 3)
- Convergence + parent PR auto-merge (Phase 4)

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

## Known Limitations (Phase 1+2)

1. **Triage regex** is pattern-based, not semantic. May misclassify edge cases.
   - Mitigation: user can manually override with --help feedback

2. **No human escalation UI yet**. When GAME_BALANCING or BLOCKING_QUESTION detected, just prints message.
   - Mitigation: next session implements `ask_user()` integration

3. **Orchestration state** is write-only (JSON Lines append). No delete/rollback.
   - Mitigation: state is immutable log; failures are just new entries

4. **Cloud session spawning not yet implemented** (Phase 3 task).
   - Mitigation: slices are decomposed and listed; spawning is a separate step

5. **Shepherd integration is documentation + force-publish hooks**. Full reactive message passing is Phase 3.
   - Mitigation: `--force-publish` arms auto-merge and logs the Shepherd watch event

---

## Related Docs

- Producer persona: `docs/agent-os/personas/producer.md`
- Shepherd skill: `.github/skills/pr-shepherd/SKILL.md`
- Review harness: `.github/skills/review-harness/SKILL.md`
- Complexity policy: `docs/agent-os/policies/complexity-policy.md`
- Cloud sessions: _(planned — not yet written)_

---

## Metrics & Success Criteria

**Phase 1+2 (current):**

- ✅ Triage correctly classifies 6 request types
- ✅ Game-design decisions are escalated (HUMAN_GATE)
- ✅ CLI is callable and usable
- ✅ Documentation is comprehensive
- ✅ Decomposition produces independent, parallelizable slices
- ✅ Orchestration state is written on every decomposition
- ✅ Force-publish arms auto-merge and logs events
- ✅ Shepherd status reflects live PR metadata

**Phase 3 (target):**

- [ ] Cloud sessions spawn correctly for each slice
- [ ] Dependent slices automatically unblock on upstream MERGED
- [ ] Progress updates every 5 minutes (or on state change)

**End-to-end (all phases):**

- [ ] Feature request → triage → decompose → parallelize → publish → auto-merge in <2 hours
- [ ] Parallelism win: time savings for multi-slice features ≥30%
- [ ] Zero manual interventions for safe (non-gameplay) features
- [ ] All gameplay decisions routed to human + recorded in handoff

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

2. **`scripts/agent/producer.ts`** (843 lines)
   - CLI entry point with option parsing
   - `handleTriage()` → classify request + output result
   - `handleDecompose()` → system analysis, persona mapping, slice creation, dependency grouping, parallel group computation, JSONL state write
   - `handleStatus()` → read + render orchestration state from `files/producer-orchestration.jsonl`
   - `handleShepherdStatus()` → query live PR metadata/check state via `gh pr view`
   - `handleForcePublish()` → publish draft PR, arm `--auto --squash`, log events
   - Triage regex patterns for 6 request types
   - Orchestration JSONL telemetry (state snapshots + discrete events)
   - Support for `--triage`, `--decompose`, `--status`, `--shepherd-status`, `--force-publish`, `--help`

3. **`package.json`**
   - Added `npm run producer` → `tsx scripts/agent/producer.ts`

### Triage Logic:

```
Input: "user request text"
  ↓
Classify by keyword matching (priority order):
  1. GAME_BALANCING (if contains balance/tuning/economy/difficulty/drops/spawn + %/winrate/playtest)
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
$ npm run producer -- --triage "Reduce winrate by 20%"
Type: GAME_BALANCING
Escalation: HUMAN_GATE
Message: 🎮 GAME BALANCING REQUEST — requires human approval before implementation

# Bug (routed to QA)
$ npm run producer -- --triage "Player walks through walls on Floor 2"
Type: DEBUGGING
Message: 🐛 DEBUGGING REQUEST — QA will reproduce and determine root cause

# Decompose a feature
$ npm run producer -- --decompose "Add loot drop animations and sound effects"
# → Slices: Game Designer (loot), Graphics Designer (graphics), Sound Designer (audio)
# → Dependencies: graphics+audio wait for Game Designer slice
# → Writes state to files/producer-orchestration.jsonl
```

---

## Phase 3: Cloud Session Spawning (Future)

**What needs to be built:**

1. `gh workflow run create-cloud-session.yml` invocation per independent slice
2. Session ID tracking in orchestration state
3. Dependent-slice unblocking on upstream MERGED events

**Estimated lines of code:** 150-200 additional lines

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

**Phase 3 Implementation:**

1. Cloud session spawning for each independent slice
2. Dependent-slice lifecycle (BLOCKED_UPSTREAM → auto-start after upstream MERGED)
3. Convergence workflow (parent PR auto-merge when all slices merge)

**Validation:**

- All 6 triage types working correctly ✅
- Decomposition produces independent, parallelizable slices ✅
- Force-publish and Shepherd handoff work ✅
- Cloud sessions spawn correctly (Phase 3)
- Convergence + parent PR auto-merge (Phase 4)

**Review Gates:**

- ✅ SKILL.md is comprehensive and follows existing producer persona doc
- ✅ Triage correctly classifies 6 request types
- ✅ Decomposition logic produces correct slice breakdown
- ✅ Force-publish arms auto-merge and logs events
- ✅ Orchestration state machine is durable + queryable
- [ ] Cloud session spawning (Phase 3)
- [ ] Shepherd reactive watch (Phase 3)
- [ ] Convergence + parent PR auto-merge (Phase 4)

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

## Known Limitations (Phase 1+2)

1. **Triage regex** is pattern-based, not semantic. May misclassify edge cases.
   - Mitigation: user can manually override with --help feedback

2. **No human escalation UI yet**. When GAME_BALANCING or BLOCKING_QUESTION detected, just prints message.
   - Mitigation: next session implements `ask_user()` integration

3. **Orchestration state** is write-only (JSON Lines append). No delete/rollback.
   - Mitigation: state is immutable log; failures are just new entries

4. **Cloud session spawning not yet implemented** (Phase 3 task).
   - Mitigation: slices are decomposed and listed; spawning is a separate step

5. **Shepherd integration is documentation + force-publish hooks**. Full reactive message passing is Phase 3.
   - Mitigation: `--force-publish` arms auto-merge and logs the Shepherd watch event

---

## Related Docs

- Producer persona: `docs/agent-os/personas/producer.md`
- Shepherd skill: `.github/skills/pr-shepherd/SKILL.md`
- Review harness: `.github/skills/review-harness/SKILL.md`
- Complexity policy: `docs/agent-os/policies/complexity-policy.md`
- Cloud sessions: _(planned — not yet written)_

---

## Metrics & Success Criteria

**Phase 1+2 (current):**

- ✅ Triage correctly classifies 6 request types
- ✅ Game-design decisions are escalated (HUMAN_GATE)
- ✅ CLI is callable and usable
- ✅ Documentation is comprehensive
- ✅ Decomposition produces independent, parallelizable slices
- ✅ Orchestration state written on every decomposition
- ✅ Force-publish arms auto-merge and logs events
- ✅ Shepherd status reflects live PR metadata

**Phase 3 (target):**

- [ ] Cloud sessions spawn correctly for each slice
- [ ] Dependent slices auto-unblock on upstream MERGED
- [ ] Progress updates every 5 minutes (or on state change)
- [ ] 80%+ of Shepherd interventions are auto-fixes (CI, reviews)
- [ ] Rework loops detected within 10 minutes
- [ ] Parent PR auto-merges once all slices converge

**End-to-end (all phases):**

- [ ] Feature request → triage → decompose → parallelize → publish → auto-merge in <2 hours
- [ ] Parallelism win: time savings for multi-slice features ≥30%
- [ ] Zero manual interventions for safe (non-gameplay) features
- [ ] All gameplay decisions routed to human + recorded in handoff
