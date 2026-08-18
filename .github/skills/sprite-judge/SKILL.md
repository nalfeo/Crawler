---
name: sprite-judge
description: >-
  Adjudicate generated sprite variants into an accept / reject / regenerate /
  escalate verdict before approval, using the pipeline's deterministic sensors,
  the opt-in VLM judge, and a human-eyeball checklist. Use when asked to "judge
  sprites", "review generated art", "score a sprite sheet", "should I approve
  this variant", "is this sprite on-style / readable", or when running the asset
  pipeline and a fresh sheet needs a verdict before `sprites:approve`. Wraps the
  existing `scoreCandidate` sensors and `judgeVariant` VLM judge — it does NOT
  reinvent scoring; it turns their output plus a game-scale eyeball into a
  repeatable review decision.
---

# Sprite Judge

Turn a freshly generated sprite sheet into a defensible **accept / reject /
regenerate / escalate** verdict — the review step between `sprites:run` and
`sprites:approve`. This is the middle of the asset loop that was previously done
by feel; this skill makes it repeatable.

> The scoring engines already exist and are unit-tested — **do not rebuild
> them.** This skill orchestrates three layers into one decision. Deep rubric,
> the full eyeball checklist, and worked accept/reject examples live in
> [`references/rubric.md`](references/rubric.md).

## The three review layers (in order)

Every variant is judged by three layers. They are **not** interchangeable — each
has a different authority:

1. **Deterministic sensors** — `scripts/sprites/score-candidate.ts`
   (`scoreCandidate`). Hard structural gate: dimensions-exact, alpha-binary,
   palette membership, opaque-bbox-fits, opaque-ratio, interior-transparency
   holes, anchor, plus family sensors (weapon orientation, character silhouette
   axis). A variant is `passed` only when **every** sensor is `ok`.
   **A sensor failure is a pipeline/brief bug, never a reason to loosen the
   sensor** (Graphics Designer persona constraint). Fix the post-processor,
   brief overrides, or prompt — then regenerate.

2. **VLM judge** — `scripts/sprites/judge.ts` (`judgeVariant`). Opt-in per brief
   via `judge.enabled: true`. Three evaluators — `style_match`, `brief_match`,
   `readability` — each scored 1–5; **any evaluator < 3 auto-rejects** the
   variant. Local-only (refuses under `CI`), costs Azure credits, and is
   bounded by a USD `JudgeBudget`. It ranks sensor-passing variants and judges
   at most `judge.maxVariants` (default 16). Its verdict lands in
   `<runDir>/processed/NN.judge.json`.

3. **Human/agent eyeball** — the **final** call. Per the Graphics Designer
   persona, subjective scores _inform_ but do **not** gate: "final approval is a
   human judgment call." Post the sheet inline, apply the eyeball checklist
   (`references/rubric.md`), and decide. The sensors and judge can pass a variant
   that still reads wrong at 16px — you own catching that.

The pipeline already ANDs the first two into `combinedPassed` (= sensors AND, if
enabled, judge). `sprites:run` prints, per variant, whether it passed
"all sensors" or "all sensors + the VLM judge". The eyeball is layer 3 on top.

## Workflow

1. **Generate** with `npm run sprites:run -- --brief <path>` (or `--all`).
   - Enable the VLM judge for unattended quality filtering by setting
     `judge: { enabled: true }` on the brief. Keep it off for fast local iteration
     where you'll eyeball every variant anyway.
   - Bound cost with `--judge-budget <usd>` (or the env cap) on large batches.
2. **Read the machine verdict.** From the `sprites:run` summary, note which
   variant indices are `combinedPassed`. Open `<runDir>/processed/NN.judge.json`
   for the per-evaluator scores + rationales when the judge ran.
3. **Post the sheet inline.** Extract the run's sheet/variant PNGs and show them
   in-session — the human reviews every sheet. This is not optional; it is the
   layer-3 gate and the standing user directive for this pipeline.
4. **Apply the eyeball checklist** (`references/rubric.md`) to each
   sensor+judge-passing variant. Reject on: illegible silhouette at 16px on a
   dark floor, transparency holes / floating pixel islands / detached fragments,
   off-family palette or outline weight, wrong footprint (see wide-mob rule), or
   a subject that doesn't match the brief.
5. **Decide** per the decision tree below.
6. **Approve the winner:** `npm run sprites:approve -- <runDir> --variant <N>`.
   This is the ONLY step that mutates checked-in state — it writes
   `public/assets/generated/<briefId>-var-<N>.png` + the manifest entry (key =
   spriteName = texture key = catalog id, all identical). Exact re-approval of an
   existing `briefId-var-N` is blocked (409) — approve a _new_ variant index or
   pass `--allow-reapprove` only for a deliberate overwrite.

## Decision tree

For each variant:

- **Sensors fail** → **reject**. If ALL variants fail the same sensor, it's a
  pipeline/brief bug → fix post-proc/brief/prompt and **regenerate** (do not
  loosen the sensor). Escalate to a human if it won't converge.
- **Sensors pass, judge < 3 on any axis** → **reject** that variant. If every
  judged variant is rejected, inspect rationales: `brief_match` low → fix the
  prompt; `style_match` low → check references/palette; `readability` low →
  silhouette/contrast problem → **regenerate**.
- **Sensors pass, judge ≥ 3 (or judge disabled), eyeball clean** → **accept**
  → approve.
- **Sensors + judge pass but eyeball says wrong** (reads bad at scale, wrong
  vibe, wrong footprint) → **reject** and regenerate; if the _brief itself_ is
  the problem (e.g. a miniboss briefed at 1×1), fix the brief.
- **Repeatedly can't converge** (≈2–3 regen rounds) → **escalate to the human**
  with the sheet + rationales. Never lower a gate to force a pass.

## Operational gotchas (these made the loop actually work)

- **Cold-call Azure flake.** The first image-gen call in a fresh `sprites:run`
  process intermittently fails with `provider error [network]: fetch failed`, and
  `network` errors are **not** retried. Mitigation: run a throwaway **warmup
  brief** first, real targets second+. Never brief-blame a network fetch-failed.
- **Env preload before every `sprites:run`** (it does not persist across shell
  calls): load `.env.local` into the process env first (Azure sidecar is required
  by default — see AGENTS.md "Azure-required sidecar policy").
- **Edge half-sprites are expected, not a bug.** The content-aware slicer
  (`slice-sheet.ts`) emits the brief's commanded cell count and lets **every**
  sheet reach human review by design; grid edges sometimes yield half/blank
  cells. Just reject those variants — don't try to "fix" the slicer for it.
- **Wide-mob sizing.** Minibosses / bosses that read as wide creatures need a
  wide footprint in the brief (rows×cols and target size), not the default
  square. A miniboss briefed at a small square silhouette is a **brief** bug —
  fix the brief, regenerate.
- **Brief id = the consumer's bare id** so the art auto-resolves. Item icons
  resolve by `itemId === briefId`; name a consumable brief `health-vial`, NOT
  `health-vial-v1`, or it won't wire. (Version-suffixed keys are exactly the
  name-variance orphan class.)

## Honesty rules (non-negotiable)

- **Never loosen a deterministic sensor** to pass a variant. A failure means the
  post-processor/brief is wrong — fix that (persona constraint + project rule
  #12).
- **Never lower the judge's `< 3` auto-reject bar** or edit a `NN.judge.json` to
  flip a verdict.
- Regenerate until genuinely clean or **escalate to a human** — do not approve
  off-style/illegible art to clear a queue.
- The judge is **local-only**; never enable it in CI (it's non-deterministic and
  costs credits — Constitutional §3).

## Related

- End-to-end pipeline agent: [`asset-forge`](../../agents/asset-forge.agent.md)
- Legacy drain (existing `asset-checkin` issues only): [`asset-pr`](../asset-pr/SKILL.md)
- Find what art can now replace a placeholder: [`placeholder-audit`](../placeholder-audit/SKILL.md)
- Review harness + ledger for any wiring code change: [`review-harness`](../review-harness/SKILL.md)
- Style ground-truth (fed to prompts AND the judge): `docs/agent-os/sprite-style.md`
- Graphics Designer persona: `docs/agent-os/personas/graphics-designer.md`
- Scoring internals (do not reinvent): `scripts/sprites/score-candidate.ts`, `scripts/sprites/judge.ts`
