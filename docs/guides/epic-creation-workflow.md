# Epic creation workflow

Cloud coding-agent sessions cannot create GitHub issues directly (no
issue-create permission). When planning a big feature and splitting it into
dependency-ordered slices, commit a declarative `*.epic.json` file describing
that layout instead of hand-writing issues. Once the file lands on `main`, the
[`epic-create`](../../.github/workflows/epic-create.yml) workflow turns it
into real GitHub issues.

**Every epic always starts with a human-review issue.** No slice/node issue is
ever created until a human closes that review issue **as completed** — this
is the gate that guarantees the plan is reviewed before implementation
begins. (A `state_reason` of anything other than `completed` — including a
`null` reason, which is what GitHub records for an issue auto-closed via a
PR's `Closes #N` keyword — does **not** count as approval.) Closing it as
**"not planned"** instead is treated as an explicit rejection of that plan
revision: no node issue is ever created for it. Each review issue is itself
scoped to a content hash of the reviewed `title`+`nodes`: if the `.epic.json`
file changes (title or nodes) after a review issue is filed or closed —
whether it was approved or rejected — no existing issue matches the new
revision, so the workflow files a **brand-new** review issue for it
automatically. A human can never be asked to approve (or reject) revision A
and have revision B materialize; the old review issue is left untouched as
history, never edited or reused.

## Authoring a `*.epic.json` file

Place the file anywhere under `docs/knowledge/epics/` (conventionally
`docs/knowledge/epics/<epic-id>/<epic-id>.epic.json`). See
[`example.epic.json.txt`](example.epic.json.txt) for a complete example. Shape:

| Field                 | Required | Description                                                                             |
| --------------------- | -------- | --------------------------------------------------------------------------------------- |
| `epic_id`             | yes      | Lowercase kebab-case identifier. Used to label every created issue as `epic:<epic_id>`. |
| `title`               | yes      | Human-readable epic name, used in the review issue title.                               |
| `description`         | no       | One paragraph of context, shown on the review issue.                                    |
| `review.title_prefix` | no       | Prefix for the review issue title (default `[Epic Review]`).                            |
| `review.body`         | no       | Extra reviewer-facing context appended to the generated plan summary.                   |
| `labels`              | no       | Extra labels applied to every issue created for this epic.                              |
| `nodes`               | yes      | Non-empty array of slice/node definitions (see below).                                  |
| `nodes[].id`          | yes      | Unique node id within the epic, referenced by other nodes' `depends_on`.                |
| `nodes[].title`       | yes      | Issue title for this node.                                                              |
| `nodes[].body`        | no       | Issue body for this node.                                                               |
| `nodes[].labels`      | no       | Extra labels applied to this node's issue only.                                         |
| `nodes[].depends_on`  | no       | Array of other node `id`s this node depends on.                                         |

## What the workflow does

1. The workflow runs [`epic-create.mjs`](../../.github/scripts/epics/epic-create.mjs)
   for every discovered epic file on: a push to `main` that touches a
   `*.epic.json` file, a manual `workflow_dispatch`, and — so approval or
   rejection takes effect promptly — whenever any issue is **closed or
   reopened**. Runs are serialized (a `concurrency` group) so overlapping
   triggers can't race each other into creating duplicate issues.
2. If no review issue matching the current file's content hash exists yet, it
   creates **only** the human-review issue (labeled `epic`, `epic:<epic_id>`,
   `epic-review`) and stops. The review issue body lists every planned node
   and its dependencies so a human can review the whole plan in one place;
   the hash is embedded in a hidden marker in the issue body. Any label an
   epic needs (the `epic:<epic_id>` label, `epic-review`, or a custom label
   from the file) is created in the repo first if it doesn't already exist —
   GitHub silently drops unknown label names from issue creation instead of
   creating them, so without this step a brand-new epic's own label would
   never actually attach and the workflow could never find its issue again.
3. On a later run, if that review issue is still open, nothing happens.
4. If the review issue is closed **as "Not planned"**, this exact plan
   revision is treated as rejected: no node issue is ever created for it.
   Re-opening the review issue returns it to the "waiting for review" state.
5. If the review issue is closed **as completed**, the workflow creates each
   node's issue in dependency order. Every node issue body includes
   `Blocked by #N` for the review issue itself plus every declared
   dependency, so the dependency graph is visible directly on GitHub.
   (`Blocked by` is plain text, not a native GitHub blocking relationship —
   GitHub's issue API has no such feature.)
6. Re-running is always safe: every managed issue carries an HTML-comment
   marker in its body, so the script only ever creates issues that do not
   already exist. It never edits or duplicates one that does.

## Relationship to the `floor-2-equipment` epic-state control plane

This is intentionally separate from the bespoke
`docs/knowledge/epics/floor-2-equipment/epic-state.json` control plane
(`npm run epic:status`, `npm run epic:materialize`), which is a human-operated
CLI built for one specific, already-in-flight epic and tracks richer
lifecycle state (claims, evidence hashes, drift audits). `epic-create.mjs` is
the lightweight, CI-driven on-ramp for _new_ epics going forward — it only
knows how to create the initial issue layout, not to track ongoing execution
state.
