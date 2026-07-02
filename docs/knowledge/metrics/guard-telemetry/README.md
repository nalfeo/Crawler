# Guard Telemetry Captures

Committed, per-session summaries of `copilot-guards` decisions. This is the
**durable, contamination-filtered** collection path the cross-session analyzer
(`scripts/agent/docs/guard-telemetry.ts`) reads, alongside legacy handoff blocks.

## How files land here

Near the end of a session where guards fired, run:

```
npm run telemetry:capture -- <session-slug>
```

This reads the session-local `files/guard-telemetry.jsonl`, filters to the
configured guard IDs (from `.github/extensions/copilot-guards/config.json`), and
writes:

```
docs/knowledge/metrics/guard-telemetry/<YYYY-MM-DD>-<slug>.json
```

If any event carries a known test-fixture guard ID (e.g. from running the guard
test suite), the **whole record** is quarantined — `events`/`guards`/`tools` are
zeroed and capture **refuses to write** the file, emitting a non-blocking
`[WARN]` (exit 0) — so synthetic fixture counts can never land in a committed
capture. This mirrors the analyzer's read-path quarantine (`cleanTelemetryRecord`).

One file per session ⇒ conflict-free; it rides your normal commit. Re-running
capture for the same session overwrites its file (idempotent, no double count).

## Schema (`agent-os-guard-telemetry-capture/v1`)

| Field                  | Meaning                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `schema`               | `agent-os-guard-telemetry-capture/v1`                                                                                             |
| `session`              | Stable session key (slug); the dedup authority for the union                                                                      |
| `date`                 | Capture date (`YYYY-MM-DD`)                                                                                                       |
| `artifact`             | Source artifact path (`files/guard-telemetry.jsonl`)                                                                              |
| `events`               | Count of accepted, configured-guard events                                                                                        |
| `guards`               | `{ "<guard_id>": { "<decision>": <count> } }` (configured only)                                                                   |
| `tools`                | `{ "<tool_name>": <count> }`                                                                                                      |
| `ignored_events`       | Count of events dropped (fixtures + unknown IDs)                                                                                  |
| `unexpected_guard_ids` | Sorted list of non-configured IDs seen (fixtures + typos)                                                                         |
| `quarantined`          | `true` when a known test-fixture ID was seen; whole record is discarded (`events`/`guards`/`tools` zeroed) and no file is written |
| `fixture_guard_ids`    | Sorted list of `KNOWN_TEST_FIXTURE_GUARD_IDS` that triggered quarantine (empty when clean)                                        |

## Analyzer

`scripts/agent/docs/guard-telemetry.ts` unions these capture files with handoff
telemetry blocks, de-duplicates by `session` (a capture file wins over a handoff
block for the same session), and grades each configured guard. See
`docs/agent-os/policies/telemetry-policy.md` for the dead-guard thresholds and
`docs/knowledge/adr/0004-chronicle-telemetry.md` (Amendment 2026-07-02) for the
rationale.
