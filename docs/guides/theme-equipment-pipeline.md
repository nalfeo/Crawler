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

Copy `data/theme-equipment-sets/classic-fantasy.json` to a stable kebab-named plan. Author the design
language directly; it should constrain materials, silhouette, palette, ornament, wear, and excluded
motifs. Do not ask synthesis to invent the collection's visual identity.

## Run on GitHub

Initialize:

```powershell
gh workflow run theme-equipment.yml --field action=init --field set_id=<set-id> --field plan_path=data/theme-equipment-sets/<set-id>.json
```

Generate or regenerate only unresolved items in the current phase:

```powershell
gh workflow run theme-equipment.yml --field action=run-phase --field set_id=<set-id>
```

Advance and status operations are storage-only and do not require OpenAI credentials. The workflow
serializes operations per set ID and allows up to six hours for large sequential collections.

## Review

Open the **Theme Equipment Review** project canvas with `setId=<set-id>`. It displays:

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
