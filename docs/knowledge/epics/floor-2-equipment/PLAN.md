# Floor 2 Equipment Epic Plan

## Purpose

This is the canonical, human-readable execution plan for the Floor 2 equipment
epic. It defines sequencing, authority, recovery, and acceptance contracts. It
does not implement equipment gameplay.

The machine-readable execution index is
`docs/knowledge/epics/floor-2-equipment/epic-state.json`. That file is a cache
and coordination index; it never overrides stronger evidence.

## Hard acceptance gate

For the representative-build benchmark, the median aggregate DPS ratio must be
between **1.7x and 2.3x** for both:

- level 1 -> level 6; and
- level 6 -> level 11.

Both intervals must pass independently. Aggregate DPS includes the complete
representative build, not one cherry-picked weapon or one seed. The benchmark
packet, seeds, build definition, raw results, and aggregation code must be
committed as deterministic evidence before the release node can validate.

## Product contract

- Equipment rarity is Common, Uncommon, or Rare. No shipped item may exceed
  Rare. Unique items are explicitly deferred from this epic.
- One versioned generated-instance registry is authoritative across inventory,
  equip/unequip, achievement rewards, chests, merchant stock, and floor
  carryover. Consumers must not maintain parallel item-instance shapes.
- Achievement equipment rewards resolve once, at unlock time, to an immutable
  generated instance. Loading, UI rendering, or later catalog edits must not
  reroll an already-resolved reward.
- Floor 1 remains equipment-free. Equipment generation, rewards, shops, and
  equip affordances are unavailable there.
- Floor 2 provides 30 floor achievements plus 6 run-global achievements.
- The Floor 2 boss chest selects rarity at 85% Uncommon and 15% Rare.
- Every Floor 2 settlement has a guaranteed Quartermaster plus 1-2 random
  non-Quartermaster shops. Shop equipment stock is Common or Uncommon only.
- The launch catalog contains at least 70 base items: exactly 50 weapons and 20
  non-weapons in the stable manifest below. Future additions append IDs; they
  do not rename or recycle them.
- Shared chests use one accessible interaction and presentation contract:
  keyboard, pointer, and touch parity; focus management; readable rarity cues
  that do not rely on color alone; and deterministic item details.
- AI settlement maintenance is extensive and must use real inventory, equip,
  merchant, chest, and carryover APIs. Travel must use the existing route
  planner. No AI-only inventory mutations, teleports, or duplicate planner may
  be introduced.

## Machine-owned plan contract

Only the JSON between the markers below participates in plan/state drift
validation. Prose outside the markers may improve without forcing a state
manifest rewrite. Changes inside the contract require the plan-change protocol.

<!-- EPIC-CONTRACT:BEGIN -->

```json
{
  "contract_version": "floor-2-equipment/v1",
  "hard_gate": {
    "metric": "representative-build median aggregate DPS ratio",
    "intervals": ["level-1-to-6", "level-6-to-11"],
    "minimum": 1.7,
    "maximum": 2.3,
    "require_each_interval": true
  },
  "rarities": ["common", "uncommon", "rare"],
  "deferred_rarities": ["unique"],
  "registry": {
    "versioned": true,
    "generated_instance": true,
    "consumers": [
      "inventory",
      "equip",
      "achievement-rewards",
      "chests",
      "merchant",
      "floor-carryover"
    ]
  },
  "progression": {
    "reward_resolution": "unlock-time-immutable",
    "floor_1_equipment_free": true,
    "floor_2_achievements": 30,
    "run_global_achievements": 6
  },
  "economy": {
    "boss_chest_rarity_percent": {
      "uncommon": 85,
      "rare": 15
    },
    "quartermaster_guaranteed": 1,
    "random_non_quartermaster_shops_min": 1,
    "random_non_quartermaster_shops_max": 2,
    "shop_rarities": ["common", "uncommon"]
  },
  "catalog": {
    "weapon_count": 50,
    "other_count": 20,
    "sprite_ids": [
      "weapon.iron-cleaver",
      "weapon.ashwood-bow",
      "weapon.quarterstaff",
      "weapon.throwing-knives",
      "weapon.war-pick",
      "weapon.hand-crossbow",
      "weapon.bone-saw",
      "weapon.chain-flail",
      "weapon.dueling-saber",
      "weapon.stone-maul",
      "weapon.musketeer-rifle",
      "weapon.ember-wand",
      "weapon.frost-crook",
      "weapon.storm-sling",
      "weapon.venom-dirk",
      "weapon.sun-hammer",
      "weapon.moon-scythe",
      "weapon.blood-lance",
      "weapon.grave-shovel",
      "weapon.butcher-hook",
      "weapon.cog-pistol",
      "weapon.alchemist-sprayer",
      "weapon.rune-axe",
      "weapon.tower-spear",
      "weapon.twin-katar",
      "weapon.thorn-whip",
      "weapon.crystal-cannon",
      "weapon.baseball-bat",
      "weapon.rivet-gun",
      "weapon.sawblade-launcher",
      "weapon.oil-lantern",
      "weapon.shock-baton",
      "weapon.boarding-axe",
      "weapon.hunting-bola",
      "weapon.spike-shield",
      "weapon.war-fan",
      "weapon.crescent-glaive",
      "weapon.siege-bow",
      "weapon.powder-keg",
      "weapon.acid-flask",
      "weapon.ice-pick",
      "weapon.flame-tongs",
      "weapon.ritual-dagger",
      "weapon.brass-knuckles",
      "weapon.meteor-hammer",
      "weapon.harpoon-gun",
      "weapon.plague-censer",
      "weapon.bone-chakram",
      "weapon.echo-bell",
      "weapon.void-rapier",
      "head.iron-visor",
      "head.quartermaster-cap",
      "head.batfolk-hood",
      "head.alchemist-goggles",
      "torso.chain-hauberk",
      "torso.velvet-coat",
      "torso.scavenger-harness",
      "torso.runed-cuirass",
      "hands.duelist-gloves",
      "hands.thorn-gauntlets",
      "hands.tinker-grips",
      "feet.iron-greaves",
      "feet.shadow-boots",
      "feet.merchant-sandals",
      "accessory.blood-vial",
      "accessory.compass-charm",
      "accessory.lucky-feather",
      "accessory.gearwork-locket",
      "accessory.warding-bell",
      "accessory.surveyor-map"
    ]
  },
  "ux": {
    "shared_chest_contract": true,
    "keyboard_pointer_touch_parity": true,
    "focus_managed": true,
    "non_color_rarity_cues": true
  },
  "ai": {
    "real_apis_only": true,
    "existing_route_planner_only": true,
    "settlement_maintenance_required": true
  },
  "graph": {
    "dependencies": {
      "slice:A0": [],
      "slice:A1": ["slice:A0"],
      "slice:B1": ["slice:A1"],
      "slice:B2": ["slice:B1"],
      "slice:B3": ["slice:B2"],
      "slice:C1": ["slice:A1"],
      "slice:C2": ["slice:C1", "slice:B3"],
      "slice:D1": ["slice:A1"],
      "packet:D2-A": ["slice:D1", "slice:B1"],
      "packet:D2-B": ["slice:D1", "slice:C1"],
      "slice:D2": ["packet:D2-A", "packet:D2-B"],
      "packet:D3-A": ["slice:D2", "slice:B2"],
      "packet:D3-B": ["slice:D2", "slice:C1"],
      "slice:D3": ["packet:D3-A", "packet:D3-B"],
      "slice:E1": ["slice:A1"],
      "slice:E2": ["slice:E1", "slice:C1"],
      "packet:E3-A": ["slice:E2", "slice:B2"],
      "packet:E3-B": ["slice:E2", "slice:D2"],
      "packet:E3-C": ["slice:E2", "slice:C1"],
      "slice:E3": ["packet:E3-A", "packet:E3-B", "packet:E3-C"],
      "slice:F1": ["slice:B1", "slice:C1"],
      "slice:F2": ["slice:F1", "slice:B2"],
      "slice:F3": ["slice:F2", "slice:E2"],
      "slice:F4": ["slice:F3", "slice:C2"],
      "slice:G1": ["slice:A1"],
      "packet:G2-A": ["slice:G1", "slice:C1"],
      "packet:G2-B+": ["slice:G1", "slice:B2"],
      "slice:G2": ["packet:G2-A", "packet:G2-B+"],
      "packet:G3": ["slice:G2", "slice:D3"],
      "slice:G3": ["packet:G3"],
      "slice:H1": ["slice:C1", "slice:F1"],
      "slice:H2": ["slice:H1", "slice:G2"],
      "slice:H3": ["slice:H2", "slice:G3"],
      "slice:I1": [
        "slice:B3",
        "slice:C2",
        "slice:D3",
        "slice:E3",
        "slice:F4",
        "slice:G3",
        "slice:H3"
      ],
      "slice:I2": ["slice:I1"],
      "slice:I3": ["slice:I2"],
      "slice:J": ["slice:I3"]
    },
    "parent_slices": {
      "slice:A0": null,
      "slice:A1": null,
      "slice:B1": null,
      "slice:B2": null,
      "slice:B3": null,
      "slice:C1": null,
      "slice:C2": null,
      "slice:D1": null,
      "packet:D2-A": "slice:D2",
      "packet:D2-B": "slice:D2",
      "slice:D2": null,
      "packet:D3-A": "slice:D3",
      "packet:D3-B": "slice:D3",
      "slice:D3": null,
      "slice:E1": null,
      "slice:E2": null,
      "packet:E3-A": "slice:E3",
      "packet:E3-B": "slice:E3",
      "packet:E3-C": "slice:E3",
      "slice:E3": null,
      "slice:F1": null,
      "slice:F2": null,
      "slice:F3": null,
      "slice:F4": null,
      "slice:G1": null,
      "packet:G2-A": "slice:G2",
      "packet:G2-B+": "slice:G2",
      "slice:G2": null,
      "packet:G3": "slice:G3",
      "slice:G3": null,
      "slice:H1": null,
      "slice:H2": null,
      "slice:H3": null,
      "slice:I1": null,
      "slice:I2": null,
      "slice:I3": null,
      "slice:J": null
    }
  }
}
```

<!-- EPIC-CONTRACT:END -->

## Durable sources of truth

Authority is field-specific and ordered from strongest to weakest:

| Fact                                   | Authority order                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Code, plan, schema, packet definitions | merged git content -> reviewed PR content -> working branch                            |
| PR head, merge state, merge commit     | GitHub PR/commit facts -> cached reconciliation metadata                               |
| Deterministic acceptance evidence      | committed evidence content/hash -> CI check tied to that commit -> issue report        |
| Claim and lease ownership              | structured child-issue comments -> parent-issue bootstrap claim for A0 -> cached state |
| Execution status/readiness             | stronger facts above -> deterministic validator result -> cached state status          |

`epic-state.json` is an index/cache. It is useful for cold starts, but it cannot
turn an unmerged PR into a merge, invent missing evidence, or supersede a newer
trusted issue claim. Until a child issue is materialized, its node is
unclaimable even if dependencies are satisfied. A0 alone may use the parent
epic issue as its bootstrap claim source.

The Producer is the sole writer of global epic state. Child agents update their
child issue and dated handoff. They never edit `epic-state.json` directly.

## Lifecycle and readiness

The normal lifecycle is:

`blocked -> ready -> claimed -> in_progress -> pr_open -> merged -> validated`

`cancelled` and `superseded` are terminal. Deferral is not a lifecycle status;
it is `release_requirement: deferred` with a required reason. Deferred nodes are
unclaimable and excluded from the release conjunction.

A required node computes ready only when:

1. every direct dependency is `validated`; or
2. a dependency is `superseded`, names a replacement, and that replacement is
   `validated`;
3. the node has a materialized issue, except for A0's parent-issue bootstrap;
4. the node itself is not terminal or already beyond ready;
5. no plan-change invalidation applies; and
6. the node has no pending `requires_main_rebase` in its `stacked_work`
   (even if all deps would otherwise be `validated`).

`cancelled` dependencies never satisfy readiness. If an active node loses
readiness after a plan change or dependency invalidation, the Producer posts
`BLOCKED`, revokes its lease, moves it to `blocked`, and invalidates downstream
evidence. Child agents do not continue under a stale claim.

Speculative stacked-work (`stacked_work` on a `blocked` node) is orthogonal to
the lifecycle. The node status remains `blocked`; `stacked_work` never enters
the ready queue. See "Speculative stacked-work protocol" for details.

Status requirements:

- `claimed`: trusted issue claim, claimant, claim timestamp, and unexpired lease.
- `in_progress`: all claimed requirements plus a current heartbeat.
- `pr_open`: issue and PR refs, observed PR head SHA, and review/handoff evidence
  identified by immutable content hash.
- `merged`: GitHub merge commit and merge timestamp.
- `validated`: merged requirements plus every node-specific deterministic
  evidence item tied to a commit or content SHA-256.

Release is permitted only when every node with
`release_requirement: required` is `validated` and all release flags have their
own validating evidence.

## GitHub operating model

### Parent epic

The parent issue is the human operating dashboard. It links this plan, the state
manifest, the status command, release gate, change protocol, and all child
issues. It does not replace committed state or evidence.

### Child issues

Each slice and cloud packet has one child issue rendered deterministically from
its stable node slug. The title/body may substitute the live parent issue number
at render time, but the canonical packet does not store a parent URL. Child
issues carry dependencies, lane, persona, acceptance evidence, and protocol.

Bulk online creation is outside A0. The acceptance path is:

1. validate offline;
2. run `npm run epic:status -- floor-2-equipment --materialization-plan`;
3. create the listed child issues through the approved issue-creation surface;
4. have the Producer record issue numbers in one global-state update; and
5. re-run offline and GitHub audits.

### Claim leases

- A claim is a structured `CLAIMED` comment on the child issue.
- Default lease: 24 hours; maximum without a heartbeat: 48 hours.
- The comment names node ID, claimant/session, base commit, claimed scope,
  timestamp, expiry, and dependency snapshot.
- Heartbeats extend the lease by posting a replacement structured comment.
- Expired claims remain historical evidence but do not confer ownership.
- Two live trusted claims for one node, or one claimant holding overlapping
  mutually-exclusive nodes, is drift requiring Producer reconciliation.

### Progress protocol

Use these exact structured headings in issue comments:

- `CLAIMED`: owner, session, base commit, scope, claimed_at, expires_at.
- `STACKED-WORK`: See "Speculative stacked-work protocol" below.
- `BLOCKED`: blocker node/fact, evidence, requested action, lease disposition.
- `UNBLOCKED`: resolving evidence and refreshed dependency snapshot.
- `SCOPE-CHANGE-REQUEST`: requested delta, rationale, impacted nodes, evidence
  invalidation, apple/review impact. This never changes scope by itself.
- `STACKED-WORK`: speculative child issue/session/PR, stacked base node/PR, and
  whether a rebase onto `main` is now required before the node can re-enter the
  authoritative ready queue.
- `HANDOFF`: branch/PR, head SHA, handoff path/hash, ledger path/hash, tests,
  unresolved risks, and next owner.

Free-form updates may follow the structured block, but automation and Producers
use only the structured fields for reconciliation.

## Speculative stacked-work protocol

A lifecycle-blocked node whose unvalidated direct prerequisites are all `pr_open`
may begin speculative work on a branch stacked from the dependency PR branch,
without advancing the node's lifecycle status. The node remains `blocked`;
speculative progress is orthogonal and never enters the ready queue.

### When speculative work is permitted

All of the following must hold before recording `stacked_work`:

1. The node's `status` is `blocked`.
2. Every unvalidated direct dependency has `status: pr_open`.
3. Every unvalidated dependency has a PR ref (`github.pr`) recorded in state.
4. A `stacked_work` block is present for every unvalidated dependency with exact
   stack-base facts (see fields below).
5. The `stacked_work.issue` ref is materialized (a live GitHub child issue).
6. There is no other node with the same `stacked_work.session` or
   `stacked_work.issue.number`.

### stacked_work fields

| Field          | Description                                                             |
| -------------- | ----------------------------------------------------------------------- |
| `mode`         | `stacked_in_progress` or `stacked_pr_open`                              |
| `issue`        | Issue ref for the speculative work's child issue                        |
| `session`      | Session identifier for the speculative work owner                       |
| `branch`       | The stacked branch name                                                 |
| `pr`           | PR ref for the speculative PR (required when mode is `stacked_pr_open`) |
| `stack_bases`  | One entry per unvalidated direct dependency (see below)                 |
| `drift_reason` | Optional material drift or block reason                                 |

### stack_bases entry fields

| Field                  | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `dependency_node_id`   | Node ID of the unvalidated direct dependency                |
| `dependency_pr_number` | PR number of the dependency                                 |
| `dependency_branch`    | Branch name of the dependency PR                            |
| `dependency_head_sha`  | Dep's head SHA when speculative work was initiated          |
| `last_resynced_at`     | Timestamp of the most recent resync with the dep            |
| `last_resynced_head`   | Dep's head SHA at last resync                               |
| `requires_main_rebase` | `true` once the dep PR merges; blocks lifecycle advancement |

### Stale-head detection

The offline validator compares `stack_base.last_resynced_head` against the dep
node's cached `github.pr.head_sha`. If they differ, the dep's PR has advanced
since the last resync and the stack is stale (`stacked.stale-dep-head` error).
The child agent must fetch the latest dep commits, merge or rebase, update
`last_resynced_head` and `last_resynced_at`, and post a `STACKED-WORK` update.

### STACKED-WORK comment protocol

Post a `STACKED-WORK` comment on the child issue to record or update speculative
progress. The structured fields are:

- `node`: the blocked node ID
- `mode`: `stacked_in_progress` or `stacked_pr_open`
- `session`: session identifier
- `branch`: stacked branch name
- `dep_snapshot`: comma-separated `<dep_node_id>:<dep_head_sha>` pairs

The Producer records these facts in one global-state update.

### Post-merge rebase and lifecycle handoff

Once a dependency PR merges:

1. The offline validator emits `stacked.merged-dep-rebase-required` if
   `requires_main_rebase` is not set to `true`; the Producer must update the
   stack_base flag.
2. When `requires_main_rebase: true`, the validator emits
   `stacked.requires-main-rebase` and an operator action requiring the Producer
   to confirm the rebase and clear `stacked_work`.
3. The child agent rebases the stacked branch onto `main`, resolves conflicts,
   and posts a `STACKED-WORK` update confirming completion.
4. The Producer verifies the rebase, clears `stacked_work` (sets it to `null`),
   and advances the node through the normal lifecycle (`blocked → ready →
claimed → ...`).
5. Normal lifecycle checks then apply; the node enters the ready queue only when
   all deps are `validated` and `stacked_work` is `null`.

The Producer is the sole writer of `stacked_work` in the global state. Child
agents post `STACKED-WORK` comments; they do not edit `epic-state.json` directly.

## Execution lanes

| Lane                | Owner persona         | Nodes                | Responsibility                              |
| ------------------- | --------------------- | -------------------- | ------------------------------------------- |
| Control             | Producer / DevOps     | A0, A1, J            | Contract, control plane, rollout            |
| Registry            | Systems Engineer      | B1-B3                | Generated-instance schema, persistence, API |
| Catalog and balance | Game Designer         | C1-C2                | 70 bases, affixes, representative benchmark |
| Progression         | Content + Game Design | D1-D3, D2/D3 packets | Achievements and immutable rewards          |
| Economy             | Game Designer         | E1-E3, E3 packets    | Shops, Quartermaster, boss chest            |
| Accessible UX       | UX Designer           | F1-F4                | Inventory/equip/chest interactions          |
| World integration   | Content + Systems     | G1-G3, G2/G3 packets | Chests, drops, carryover                    |
| AI settlement       | AI / Systems          | H1-H3                | Real-API maintenance and routing            |
| Verification        | QA Engineer           | I1-I3                | Integration, determinism, performance       |

## Slice definitions

| Node | Depends on                 | Deliverable                                                 |
| ---- | -------------------------- | ----------------------------------------------------------- |
| A0   | -                          | Durable plan, state/schema, validator, audit, recovery      |
| A1   | A0                         | Implementation contracts, flags, and registry API spec lock |
| B1   | A1                         | Versioned generated-instance types and constructors         |
| B2   | B1                         | Inventory/equip registry APIs and migration behavior        |
| B3   | B2                         | Save/load and Floor 2 carryover persistence                 |
| C1   | A1                         | Stable 70-base catalog and sprite-key data                  |
| C2   | C1, B3                     | Affix/tier generation and DPS benchmark harness             |
| D1   | A1                         | Achievement equipment reward definitions                    |
| D2   | D2-A, D2-B                 | 30 Floor 2 achievement integration                          |
| D3   | D3-A, D3-B                 | 6 run-global achievement integration                        |
| E1   | A1                         | Equipment economy and stock contract                        |
| E2   | E1, C1                     | Quartermaster and random-shop selection                     |
| E3   | E3-A, E3-B, E3-C           | Chest/shop reward integration                               |
| F1   | B1, C1                     | Shared item details and rarity presentation                 |
| F2   | F1, B2                     | Inventory and equip interaction                             |
| F3   | F2, E2                     | Merchant equipment interaction                              |
| F4   | F3, C2                     | Accessible shared chest UX                                  |
| G1   | A1                         | Floor 2 equipment feature boundaries; Floor 1 remains off   |
| G2   | G2-A, G2-B+                | World chest/drop placement and generation                   |
| G3   | packet G3                  | Carryover and floor-transition integration                  |
| H1   | C1, F1                     | AI equipment evaluation policy                              |
| H2   | H1, G2                     | Settlement maintenance through real APIs                    |
| H3   | H2, G3                     | Existing-route-planner execution and recovery               |
| I1   | B3, C2, D3, E3, F4, G3, H3 | End-to-end deterministic integration                        |
| I2   | I1                         | Representative-build DPS gate and broad regressions         |
| I3   | I2                         | Accessibility, save compatibility, and release evidence     |
| J    | I3                         | Flag rollout, validation, and epic closure                  |

## Cloud packet breakdown

Cloud packets are independently claimable child nodes, not informal subtasks.

| Packet | Parent slice | Depends on | Scope                                       |
| ------ | ------------ | ---------- | ------------------------------------------- |
| D2-A   | D2           | D1, B1     | Floor 2 achievement definitions 1-15        |
| D2-B   | D2           | D1, C1     | Floor 2 achievement definitions 16-30       |
| D3-A   | D3           | D2, B2     | Run-global definitions 1-3                  |
| D3-B   | D3           | D2, C1     | Run-global definitions 4-6                  |
| E3-A   | E3           | E2, B2     | Quartermaster equipment stock/rewards       |
| E3-B   | E3           | E2, D2     | Non-Quartermaster stock/rewards             |
| E3-C   | E3           | E2, C1     | Boss chest 85/15 reward generation          |
| G2-A   | G2           | G1, C1     | Authored shared-chest placements            |
| G2-B+  | G2           | G1, B2     | Drops, registry integration, overflow cases |
| G3     | G3           | G2, D3     | Carryover and transition packet             |

## Dependency waves

The validator computes the authoritative ready queue. These waves are planning
guidance and may contain parallel nodes:

1. Wave 0: A0.
2. Wave 1: A1.
3. Wave 2: B1, C1, D1, E1, G1.
4. Wave 3: B2, D2-A, D2-B, E2, F1, G2-A.
5. Wave 4: B3, D2, E3-A, E3-C, F2, G2-B+.
6. Wave 5: C2, D3-A, D3-B, E3-B, F3, G2.
7. Wave 6: D3, E3, H1.
8. Wave 7: F4, packet G3, H2.
9. Wave 8: G3.
10. Wave 9: H3.
11. Wave 10: I1.
12. Wave 11: I2.
13. Wave 12: I3.
14. Wave 13: J.

## Test and evidence plan

- Registry: constructor/version/property tests; inventory/equip/save integration;
  migration and duplicate-instance rejection.
- Catalog: exact ID/count/sprite coverage; rarity/affix invariants; no rarity
  above Rare.
- Rewards: unlock-time immutability; achievement counts; no Floor 1 reward path.
- Economy: deterministic shop count; guaranteed Quartermaster; stock rarity;
  boss chest statistical table exactness and deterministic selection tests.
- UX: keyboard/pointer/touch parity; focus return; text/non-color rarity cues;
  shared chest contract.
- World/carryover: deterministic placement, pickup, overflow, save/load, and
  floor transition.
- AI: only public APIs; existing route planner; no teleport/direct mutation;
  blocked-path and full-inventory recovery.
- Release: representative-build median aggregate DPS ratio in [1.7, 2.3] for
  both required intervals, plus existing Floor 1 regression gates.

Each validating evidence record identifies its kind, path or check, SHA-256,
commit, and recording time. A branch name or mutable PR URL alone is never
validation evidence.

## Release flags

All flags default off and are enabled only through node J after required nodes
validate:

| Flag                           | Validating nodes |
| ------------------------------ | ---------------- |
| `floor2EquipmentRegistry`      | B3, I1           |
| `floor2EquipmentCatalog`       | C2, I2           |
| `floor2EquipmentRewards`       | D3, I1           |
| `floor2EquipmentEconomy`       | E3, I1           |
| `floor2EquipmentUx`            | F4, I3           |
| `floor2EquipmentWorld`         | G3, I1           |
| `floor2EquipmentAiMaintenance` | H3, I2           |

No flag may expose equipment on Floor 1.

## Stable sprite manifest

The following IDs are immutable public asset keys. The canonical runtime key is
`equipment/<id with the first "." replaced by "/">`. Rarity, affix, and rolled
stats do not create new base sprite IDs.

|   # | Stable ID                   | Slot      |
| --: | --------------------------- | --------- |
|   1 | `weapon.iron-cleaver`       | weapon    |
|   2 | `weapon.ashwood-bow`        | weapon    |
|   3 | `weapon.quarterstaff`       | weapon    |
|   4 | `weapon.throwing-knives`    | weapon    |
|   5 | `weapon.war-pick`           | weapon    |
|   6 | `weapon.hand-crossbow`      | weapon    |
|   7 | `weapon.bone-saw`           | weapon    |
|   8 | `weapon.chain-flail`        | weapon    |
|   9 | `weapon.dueling-saber`      | weapon    |
|  10 | `weapon.stone-maul`         | weapon    |
|  11 | `weapon.musketeer-rifle`    | weapon    |
|  12 | `weapon.ember-wand`         | weapon    |
|  13 | `weapon.frost-crook`        | weapon    |
|  14 | `weapon.storm-sling`        | weapon    |
|  15 | `weapon.venom-dirk`         | weapon    |
|  16 | `weapon.sun-hammer`         | weapon    |
|  17 | `weapon.moon-scythe`        | weapon    |
|  18 | `weapon.blood-lance`        | weapon    |
|  19 | `weapon.grave-shovel`       | weapon    |
|  20 | `weapon.butcher-hook`       | weapon    |
|  21 | `weapon.cog-pistol`         | weapon    |
|  22 | `weapon.alchemist-sprayer`  | weapon    |
|  23 | `weapon.rune-axe`           | weapon    |
|  24 | `weapon.tower-spear`        | weapon    |
|  25 | `weapon.twin-katar`         | weapon    |
|  26 | `weapon.thorn-whip`         | weapon    |
|  27 | `weapon.crystal-cannon`     | weapon    |
|  28 | `weapon.baseball-bat`       | weapon    |
|  29 | `weapon.rivet-gun`          | weapon    |
|  30 | `weapon.sawblade-launcher`  | weapon    |
|  31 | `weapon.oil-lantern`        | weapon    |
|  32 | `weapon.shock-baton`        | weapon    |
|  33 | `weapon.boarding-axe`       | weapon    |
|  34 | `weapon.hunting-bola`       | weapon    |
|  35 | `weapon.spike-shield`       | weapon    |
|  36 | `weapon.war-fan`            | weapon    |
|  37 | `weapon.crescent-glaive`    | weapon    |
|  38 | `weapon.siege-bow`          | weapon    |
|  39 | `weapon.powder-keg`         | weapon    |
|  40 | `weapon.acid-flask`         | weapon    |
|  41 | `weapon.ice-pick`           | weapon    |
|  42 | `weapon.flame-tongs`        | weapon    |
|  43 | `weapon.ritual-dagger`      | weapon    |
|  44 | `weapon.brass-knuckles`     | weapon    |
|  45 | `weapon.meteor-hammer`      | weapon    |
|  46 | `weapon.harpoon-gun`        | weapon    |
|  47 | `weapon.plague-censer`      | weapon    |
|  48 | `weapon.bone-chakram`       | weapon    |
|  49 | `weapon.echo-bell`          | weapon    |
|  50 | `weapon.void-rapier`        | weapon    |
|  51 | `head.iron-visor`           | head      |
|  52 | `head.quartermaster-cap`    | head      |
|  53 | `head.batfolk-hood`         | head      |
|  54 | `head.alchemist-goggles`    | head      |
|  55 | `torso.chain-hauberk`       | torso     |
|  56 | `torso.velvet-coat`         | torso     |
|  57 | `torso.scavenger-harness`   | torso     |
|  58 | `torso.runed-cuirass`       | torso     |
|  59 | `hands.duelist-gloves`      | hands     |
|  60 | `hands.thorn-gauntlets`     | hands     |
|  61 | `hands.tinker-grips`        | hands     |
|  62 | `feet.iron-greaves`         | feet      |
|  63 | `feet.shadow-boots`         | feet      |
|  64 | `feet.merchant-sandals`     | feet      |
|  65 | `accessory.blood-vial`      | accessory |
|  66 | `accessory.compass-charm`   | accessory |
|  67 | `accessory.lucky-feather`   | accessory |
|  68 | `accessory.gearwork-locket` | accessory |
|  69 | `accessory.warding-bell`    | accessory |
|  70 | `accessory.surveyor-map`    | accessory |

## Cold-start and disaster-recovery runbook

A fresh Producer must be able to resume with zero conversation context:

1. Read this plan, the schema, and `epic-state.json`.
2. Run `npm run epic:status -- floor-2-equipment`.
3. Query the parent/child issues, PRs, workflow runs, and referenced branches.
4. Inspect every referenced handoff and review ledger; verify content hashes and
   commits rather than trusting branch names.
5. For any node with `stacked_work`, inspect the stacked branch and the
   dependency PR to verify `last_resynced_head` is current and
   `requires_main_rebase` is correct.
6. Run
   `npm run epic:status -- floor-2-equipment --github --reconcile`.
7. Review the emitted `repo_patch` and `operator_actions`; the command writes
   nothing.
8. Resolve stronger-fact conflicts in authority order. Do not copy cached state
   over GitHub or committed evidence.
9. Post structured BLOCKED/UNBLOCKED/STACKED-WORK/HANDOFF comments as needed.
10. As sole global-state writer, apply one reviewed state update.
11. Dispatch only nodes in the validator-computed ready queue with materialized
    child issues.

If the parent issue is unavailable, merged git and deterministic evidence still
permit recovery. Recreate the issue dashboard from the materialization plan,
then reconcile issue numbers into state. A session transcript or local
worktree is never authoritative.

For stacked-work reconciliation after a prerequisite merges:

1. Confirm the stacked branch has been rebased onto `main`.
2. Verify the speculative work is still valid (no merge-conflict regressions).
3. Update the stack_base `requires_main_rebase` to `true` if not already set.
4. After rebase confirmation, clear `stacked_work` (set to `null`) and advance
   the node through the normal lifecycle in one coordinated state update.

## Durable plan-change protocol

1. Open a `SCOPE-CHANGE-REQUEST` on the parent issue. Child issue comments alone
   cannot authorize a global change.
2. Producer performs impact analysis: affected contract fields, nodes, DAG,
   sprite IDs, evidence, claims, flags, apple tier, and review tier.
3. Pause affected nodes and revoke leases that no longer match ready scope.
4. Update the plan contract, schema/state, and affected issue packets together.
5. Update parent and child issues so links and acceptance criteria agree.
6. Run the apple-scaled plan/code review required by the changed scope.
7. Invalidate evidence whose inputs or acceptance contract changed; retain it as
   history but do not count it toward validation.
8. Revalidate deterministic evidence and reconcile stronger facts.
9. Producer commits the coordinated update and dispatches only the recomputed
   ready queue.

Renaming or recycling stable sprite IDs is a breaking plan change and requires
an explicit migration, not a silent edit.

## A0 scope boundary

A0 includes only this plan, schema/state, deterministic status/audit tooling,
tests, workflow, parent issue bootstrap, review evidence, and handoff. It
excludes live child-issue writes, equipment runtime code, item tuning,
achievement behavior, merchant behavior, chest behavior, settlement AI,
route-planner changes, registry consumers, and sprite production.
