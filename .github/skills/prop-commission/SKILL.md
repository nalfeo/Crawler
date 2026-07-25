---
name: prop-commission
description: >-
  Turn a set piece's ranked art gaps into sprite briefs, hand them to Asset Forge for
  generation, and iterate rejects with room-specific critique. Use after
  `prop-inventory` produces a gap list, when asked to "request art for this room",
  "commission props", "get the missing furniture made", or when a generated prop does
  not fit the room and needs a regeneration with feedback. Owns the request-and-iterate
  loop; it does NOT own generation itself (that is Asset Forge).
---

# Prop Commission

Requesting art is easy; requesting art that lands _in this room_ is the skill. The
difference is the **room art contract** from `set-piece-blockout` — every brief
inherits it, so props come back already agreeing on palette, light and scale instead
of each being individually plausible and collectively incoherent.

**Precondition:** a ranked gap list from `prop-inventory` and a room art contract.

## Division of labour

| Who                                                     | Owns                                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **This skill**                                          | What to request, how to describe it, whether the result fits the room, and the critique when it does not |
| **Asset Forge** (`.github/agents/asset-forge.agent.md`) | brief → Azure generate → sensors → judge → approve → check-in → art PR                                   |
| **`sprite-judge` skill**                                | Whether a sprite is good _in isolation_                                                                  |

Never rebuild the generation pipeline. Hand off, then evaluate the result **in
context**, which is the one judgment Asset Forge and the sprite judge structurally
cannot make: they see the sprite on a neutral background, you see it in the room.

## Authoring a brief

1. **Name it after the consumer.** The set-piece prop uses a `custom` sprite ref with
   a `requestId`; name the brief that exact bare id so the art auto-resolves on merge.
   Version/variant-suffixed names are the orphan class that leaves art
   generated-but-unwired.
2. **Keep the brief minimal.** Briefs inherit type defaults
   (`data/sprite-types/<type>.json`). Override only what genuinely differs.
3. **Inject the room art contract verbatim** into every brief in the batch — palette
   subset, light direction, shadow convention, wear/era. This is the whole point.
4. **State the footprint in feet, and the aspect it implies.** 1 tile = 2 ft. A
   `widthTiles`/`heightTiles` that disagrees with the intended feet produces art that
   cannot be placed without distortion.
5. **Describe function, not just appearance.** "A rental-counter CRT showing a blue
   screen, bolted down, cables trailing left" beats "a monitor". The lookbook's second
   principle is that furniture is the fastest storytelling layer — briefs should carry
   that story.
6. **Batch by zone.** Props from one zone generated together share context and cohere
   better than props batched by type.

## The iteration loop

When a generated prop comes back, judge it **in the room**, not on the sheet.

Reject and regenerate when any of these are true:

| Symptom                            | Critique to give                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Wrong apparent scale               | "Reads as ~4 ft wide; the room needs 1.5 ft. Reduce internal detail density so it holds up small."              |
| Palette drift                      | "Warmer/more saturated than the room's palette subset (`<list>`). Re-generate inside that subset."              |
| Lighting mismatch                  | "Top-lit; this room is lit from the top-left with a down-right contact shadow. Match it or it reads pasted-in." |
| Silhouette illegible at game scale | "Silhouette collapses at 16px; simplify to 2–3 masses."                                                         |
| Wrong era/wear                     | "Reads clean and modern; the room is 1990s and grimy. Add wear at contact edges."                               |
| Right prop, wrong aspect           | "Needs a wide horizontal read (8x2.5 ft); this is drawn tall."                                                  |

**Critique rules:**

- Always name **which contract term** was violated. "Doesn't fit" is not actionable.
- Always state the **target**, not just the defect ("needs 1.5 ft", not "too big").
- One regeneration round per prop before escalating. If two rounds fail, the brief is
  wrong or the concept is under-specified — fix the brief, do not keep re-rolling.
- **Never accept an off-contract prop to keep moving.** That is how a room ends up
  assembled from spare parts. Placeholders exist precisely so dressing is not blocked.

## Working while art generates

Generation is the slow step, so do not idle:

1. Place the prop **now** with a `custom` ref and a `placeholder` (a catalog or sheet
   stand-in) at the correct `widthFt`/`heightFt`.
2. Continue `set-piece-dress` against the placeholders — composition, density,
   stacking and circulation are all art-independent.
3. Swap `custom` refs for `catalog` refs as art lands and merges.

This keeps the layout work and the art work in parallel and means the room is
composed and gate-green before the final art arrives.

## Done when

Every ranked gap either has approved art in the catalog or a placed `custom` ref with
a placeholder and a brief in flight. State the status of each gap.

## Related

- `.github/skills/prop-inventory/SKILL.md` (previous step — produces the gap list)
- `.github/skills/set-piece-dress/SKILL.md` (runs in parallel on placeholders)
- `.github/agents/asset-forge.agent.md` (owns generation)
- `.github/skills/sprite-judge/SKILL.md` (per-sprite quality)
- `docs/agent-os/sprite-style.md` (global style ground truth the contract narrows)
- `scripts/sprites/brief-schema.ts`, `briefs/README.md`
