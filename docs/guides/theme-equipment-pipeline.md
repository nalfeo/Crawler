# Theme Equipment Pipeline

The theme-equipment pipeline produces a cohesive, reusable equipment art collection from one
authored theme. It layers collection planning and review over the existing sprite synthesis,
generation, post-processing, sensor, VLM judge, approval, and queue-publication machinery.

## Collection contract

| Gate               | Requirement                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| Weapons            | At least 5 distinct weapon types                                                     |
| Non-hand equipment | At least 11 of the 16 slots other than `mainHand` / `offHand`                        |
| Variants           | 1–3 approved variants per item                                                       |
| Review             | Item up reviews, whole-set up review, and collection judge score ≥3/5 in every phase |
| Publication        | One atomic queue commit; no partial sets                                             |

The four durable phases are `roster`, `briefs`, `sprite-sheets`, and `variant-approval`. A passing
item freezes. Only rejected or unresolved items run again, and any changed verdict invalidates the
whole-set approvals.

## Author a theme

Open the **Theme Equipment Review** canvas with no `setId`. It boots into the set index, which lists
every authored plan in `data/theme-equipment-sets/` alongside its durable state (`not initialized`,
`phase … · r<n>`, or `state invalid`). Use **+ New theme** to author a set:

1. Enter a kebab-case set id, a display name, and the **theme design language**. The design language
   is human-authored by contract and drives every downstream art prompt — it should constrain
   materials, silhouette, palette, ornament, wear, and excluded motifs. Synthesis never invents it.
2. **Synthesize roster** asks a model for the item roster only. The proposal is validated with the
   same authority that validates hand-written plans, so schema errors, duplicate ids, unknown slots,
   and coverage shortfalls all fail identically. A bounded repair loop feeds the deterministic
   failure back to the model; it hard-fails rather than relaxing coverage.
3. Edit the proposed JSON directly. The coverage meter updates live and the server re-validates on
   save.
4. **Save plan to repo** writes `data/theme-equipment-sets/<set-id>.json`. The path is derived
   server-side from the validated `plan.id`; the client cannot supply one.

Copying an existing plan by hand remains fully supported — the index and the workflow do not care
how the file was produced.

Plans are **immutable once durable state exists** for that set id. Saving over a live set is refused
with no override, because the workflow's state machine is keyed to the roster it was initialized
with. To change a live roster, use a new set id.

## Run on GitHub

Commit and push the plan before initializing. The workflow reads the plan from the pushed ref, not
your working tree, and dispatch pins `--ref` to the current branch (dispatch without a pinned ref
targets the default branch). Initialization verifies the plan blob exists on that remote ref and
fails fast otherwise.

Initialize:

```powershell
gh workflow run theme-equipment.yml --ref <branch> --field action=init --field set_id=<set-id> --field plan_path=data/theme-equipment-sets/<set-id>.json
```

Generate or regenerate only unresolved items in the current phase:

```powershell
gh workflow run theme-equipment.yml --field action=run-phase --field set_id=<set-id>
```

Advance and status operations are storage-only and do not require OpenAI credentials. The workflow
serializes operations per set ID and allows up to six hours for large sequential collections.

## Review

Open the **Theme Equipment Review** project canvas. With no `setId` it boots into the set index;
opening a set (or passing `setId=<set-id>`) shows the review board, which displays:

- all phase artifacts and image/YAML previews;
- item thumbs, optional feedback, revision, and frozen/open status;
- weapon and non-hand-slot coverage;
- whole-set human review and collection-judge score/rationale;
- canonical gate failures and phase controls;
- GitHub dispatch controls for paid phase work and atomic publication.

Review mutations use expected state revisions. If another reviewer or workflow updates the set,
refresh rather than overwriting the newer revision.

## Publish

After the state reaches `complete`, dispatch:

```powershell
gh workflow run theme-equipment.yml --field action=publish --field set_id=<set-id>
```

Publication stages the current generated-art manifest/catalog and complete source-run artifacts,
approves every selected variant, and performs one queue commit for the entire collection. The
durable publication state remains `held` if any part fails.

## Reusable surfaces

- Agent: `equipment-theme-forge`
- Skill: `theme-equipment-forge`
- Canvas: `theme-equipment-review`
- CLI: `npm run sprites:theme-equipment -- <action>`
- Workflow: `.github/workflows/theme-equipment.yml`
- State key: `theme-sets/<set-id>/state.json`
