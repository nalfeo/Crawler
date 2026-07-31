# Door art N/S and E/W variants (Asset Forge, art-only)

## Systems touched

sprite-pipeline, sprite-workflow

## Task

Produce two new door sprite variants for Floor 1 as an art-only change (no
renderer edits): a TALLER front-facing (N/S) door at a target opaque-box
aspect near 1:1.6 (width:height), and a genuinely side-on (E/W) door drawn
from scratch rather than a rotated front elevation, each with closed + open
states. Root cause: doors are height-authoritative-fitted at
`DOOR_TARGET_HEIGHT_FT = 6.5` (see `src/engine/sprites/door-visuals.ts`
doc block ~line 34-53), which makes them ~5.2 ft wide in a 4 ft cell,
overhanging visible floor. Maintainer decision: clamp width to the cell and
regain height from taller art instead of stretching.

## Outcome summary

| Track                     | Status      | Detail                                                    |
| ------------------------- | ----------- | --------------------------------------------------------- |
| N/S taller door (closed)  | **Blocked** | Generator capability ceiling, not approved                |
| N/S taller door (open)    | **Blocked** | Same ceiling, not approved                                |
| E/W side-on door (closed) | **Shipped** | `tile-door-sideon-v1-var-0` approved & checked in this PR |
| E/W side-on door (open)   | **Blocked** | Reliable archway regression, not approved                 |

Only the E/W closed door met the bar for approval this session. Everything
else is documented as a generator-capability finding rather than silently
approved at a lower bar, per task instructions ("stop and report" instead of
"quietly accept... and call it done").

## N/S taller door: capability ceiling (confirmed, 6 attempts)

`briefs/props/tile-door-tall-v1.yaml` / `tile-door-tall-open-v1.yaml` target
an opaque-box aspect near 0.615 (w:h) so a width-clamped-to-4ft door still
reaches 6.5 ft tall. Across 6 total generation attempts (multiple brief
revisions, explicit framing/composition guidance, narrower canvas
variants), every delivered candidate's measured aspect landed in the
0.75-1.0 band -- never closer to the 0.615 target. This mirrors the
pre-existing finding in `door-visuals.ts`'s own doc block: three prior
brief rounds asking for ~1:1.75 already failed to move the delivered aspect
at all. Treat this as a real generator ceiling for this aspect target, not
a prompting gap -- full attempt history and measured numbers are recorded
in the brief files' comment headers.

**Nothing from this track was approved.** No N/S taller door art shipped in
this PR; the existing `tile-door-v1-var-9` / `tile-door-open-v1-var-0` art
remains in use.

## E/W side-on CLOSED door: shipped

Investigated whether the existing `-side-` keys
(`tile-door-side-v1-var-0`, etc.) were genuinely side-on -- they are not;
the renderer quarter-turns the front-facing art regardless of key name,
which is exactly the convention the maintainer asked us to retire.

`briefs/props/tile-door-sideon-v1.yaml` is a from-scratch brief targeting a
genuinely non-square 48x128 physical canvas (not just prompt guidance --
the actual delivered canvas shape), since revision 1/2 attempts on a square
128x128 canvas kept producing front-facing doors regardless of how
explicit the "edge-on" prose was. The narrow canvas structurally forced the
model to draw genuinely edge-on strips for the first time.

Approved candidate: **`tile-door-sideon-v1` variant 0**

- Measured opaque-box aspect: **0.474** (w:h), canvas ~68px wide x 128px
  tall inside the 256x256 cell -- narrower than the front-facing door as
  required, and does not overflow north.
- Sensors: 7/7. Judge: 5/5/5/5/5 (design language, style match, brief
  match, readability, presentation), explicitly citing "edge-on view,"
  stone jamb, timber edge with end-grain, iron straps, and a handle stub.
- Confirmed genuinely side-on via direct visual inspection: shows a narrow
  vertical door-edge strip with jamb and hardware, not a compressed
  front-facing door.
- Approved via `sprites:approve`, checked in via `sprites:checkin`, and
  committed directly to this PR (see brief file for authoring history).

## E/W side-on OPEN door: blocked (novel failure mode)

`briefs/props/tile-door-sideon-open-v1.yaml` (the open-door sibling) hit a
**different, previously-undocumented failure mode**: on the narrow 48x128
canvas the model reliably defaults to drawing a symmetric, rounded-top
ARCHWAY (stone framing both sides + curved lintel) instead of the target
asymmetric strip (jamb on the left only, flat square top, unbordered dark
gap on the right/top) -- a compressed front elevation of an arch, not an
edge-on strip.

Across 6 total attempts (2 pre-reinforcement, 4 after an explicit,
multi-paragraph "DO NOT DRAW AN ARCHWAY" brief rewrite naming the exact
banned shape and demanding sharp 90-degree corners):

- 1 attempt reached the correct asymmetric/flat-top composition, but the
  pipeline's slicer merged all 16 sub-images into a single blob that run,
  so it could not be approved (no clean multi-candidate separation, and the
  merge corrupted sensor scoring for that one candidate).
- The other 5 attempts (2 pre-reinforcement, 3 post-reinforcement)
  reverted to the archway shape uniformly across all/most of their 16
  candidates, confirmed by direct visual inspection of the full sheets each
  time.

**The judge is a reliable filter here** -- it correctly hard-blocked every
archway candidate (score 1-2/5, citing "curved top" / "symmetric framing"
back from the brief's own banned-shape language), so the bottleneck is
purely generator-side, not a sensor/judge blind spot (unlike the earlier
front-facing-vs-edge-on confusion in revision 1/2, which sensors and judge
could not detect at all).

**Nothing from this track was approved.** No E/W open door art shipped in
this PR. Follow-up options for a future session, in the brief's own
"MEASURED OUTCOME / CONCLUSION" comment block:
(a) an even narrower canvas to remove any residual room for a two-sided
reading, (b) image-conditioned generation instead of prose-only
description, or (c) accepting the one verified-correct candidate via
manual override with explicit maintainer sign-off (its composition is
confirmed correct despite failing sensors on extraction artifacts alone) --
not attempted here since that requires a human decision, not a unilateral
agent approval.

## Stray asset-checkin issue

Running `npm run sprites:checkin` pushed a separate `assets/checkin-*`
branch and opened issue #2374 (the normal batched asset-checkin queue
flow). Since this session ships the same approved asset directly in this
PR, that issue is redundant for this specific asset and should be closed
once this PR merges to avoid double-processing via the `asset-pr` skill.

## Files

- `briefs/props/tile-door-tall-v1.yaml` / `tile-door-tall-open-v1.yaml` --
  N/S door briefs, carry full "MEASURED OUTCOME" ceiling documentation.
- `briefs/props/tile-door-sideon-v1.yaml` -- E/W closed door brief
  (revision 3), the brief behind the shipped candidate.
- `briefs/props/tile-door-sideon-open-v1.yaml` -- E/W open door brief
  (revision 4 + conclusion), documents the archway-regression finding.
- `public/assets/generated/tile-door-sideon-v1-var-0.png` +
  `entries/tile-door-sideon-v1-var-0.json` -- the shipped E/W closed door
  asset.
- `src/engine/sprites/door-visuals.ts` -- renderer reference only, NOT
  edited this session; wiring the new E/W closed art (and any future
  approved N/S/E-W-open art) into the renderer is an explicit follow-up
  PR, out of scope here.

## Next steps for a follow-up session

1. Wire `tile-door-sideon-v1-var-0` into `door-visuals.ts` for genuine E/W
   closed doors (replacing the rotate-front-facing-art convention for that
   state), verified against the 4 ft cell.
2. Decide on the E/W open door path (a/b/c above) and re-attempt.
3. Decide whether the N/S taller door target should be relaxed (e.g. to
   the observed 0.75-1.0 achievable band) or whether a different
   generation approach/model is worth trying before concluding the target
   itself needs revisiting with the maintainer.
4. Close issue #2374 once this PR merges.
