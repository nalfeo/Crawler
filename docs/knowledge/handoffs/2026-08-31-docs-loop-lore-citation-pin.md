# Session Handoff: Docs Update Loop — pin Lore-Bible-cited handoffs from archiving

## Date

2026-08-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎 exact

## What Was Done

Fixed the Docs Update Loop failure in run 33432567076. `check-lore-canon.ts` reported
`Lore source citation points to a missing path: docs/knowledge/handoffs/2026-07-24-floor2-environmental-content.md`
even though that file is committed on `main`. The file went missing _within the job_: the
`Archive handoffs older than 30 days` step moved 612 handoffs (that one included, age 38d)
into `docs/knowledge/handoffs/archive/`, and the deliberate `Revalidate lore canon after
archive` step then hard-blocked on the citation the archiver had just dangled.

`archive-handoffs.ts` now pins handoffs cited by the Lore Bible: the per-file policy moved
into a pure exported `decideHandoff(entry, today, pinned)` returning
`unnamed | fresh | pinned | archive`, fed by a new `loreCitedPaths()` export on
`check-lore-canon.ts`. Everything else still archives (611 files this run) and the
post-archive gate still hard-blocks — only the archiver's ability to break the invariant
went away.

Observed in the real automation artifact, not a lab: running
`npx tsx scripts/agent/docs/archive-handoffs.ts --apply` then `check-lore-canon.ts` against
the real repo tree reproduced the CI failure exactly (2 blocking, exit 1) before the change,
and after it prints `Pinned 2026-07-24-floor2-environmental-content.md (age 38d): cited by
the Lore Bible.` / `Archived 611 handoff file(s).` with the lore gate at exit 0.

## Key Decisions Made

Pinned the cited handoff in place rather than rewriting the Lore Bible citation to the
archive path. Rewriting would have to mutate both the link target and the display text of
every citation on every future archive run, and a canon-provenance file is the wrong thing
for an automated mover to edit. Pinning keeps the Lore Bible's cited sources live, which is
what the provenance contract actually means.

Did not touch the gate. The post-archive revalidation exists precisely to catch this class
of break; the bug was the archiver creating the break, not the gate reporting it.

## What's Next / Blockers

No blockers. The docs loop should go green on its next run. Note that the second Lore Bible
handoff citation (`2026-08-01-welcome-room-v2-redesign.md`) crosses 30 days imminently and
is now covered by the same pin.

## Retrospective

### Lessons Learned

A CI error naming a file that demonstrably exists in the repo means something earlier in the
same job mutated the tree. Reading the failing step's log tail in isolation makes it look
like a broken citation authored by a human; reading the step _before_ it showed 612 renames.
Check for in-job mutation before trusting "missing file" at face value.

`archive-handoffs.ts` executed `main()` at import, so it could not be unit-tested at all.
`check-lore-canon.ts` in the same directory already had the `process.argv[1]` entry guard —
the convention existed, it just had not been applied here.

### Mistakes Made

First regression test asserted against the _source text_ of `archive-handoffs.ts`
(`expect(source).toContain(...)`). That mirrors a real repo convention for AI-runner/UX
wiring tests, but it was the wrong reach here: the logic was extractable as a pure function,
so a real behavioral test was available and the source-string version would have passed
against a renamed variable with broken behavior. Reach for the source-string pattern only
when the call site genuinely cannot be imported.

Also briefly left the 611 archive moves staged in the working tree. Those belong to the docs
loop's own automation PR, not to a fix branch — reverted before committing.

### Opportunities for Future Improvement

`check-paths.ts` runs _before_ the archive step and is `continue-on-error`, so any non-lore
doc that links to a handoff silently rots on archive day. A post-archive path revalidation,
or teaching the archiver to leave a redirect stub, would close that broader hole; only the
lore citations are protected today.
