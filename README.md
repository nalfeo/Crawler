# Baselines branch

This branch stores baseline win-rate sweeps captured after every
successful GitHub Pages deploy from main. Each release commit gets
one file under by-sha/<commit-sha>.json, and index.json is a
chronological log sorted by commit date (newest first).

index.json is regenerated from by-sha/*.json on every publish, so
concurrent baseline jobs never conflict on it.

Use npm run perf:find-baseline to resolve the baseline that was in
effect when a feature branch forked from main. Do not merge this
branch into main; it is history storage only.
