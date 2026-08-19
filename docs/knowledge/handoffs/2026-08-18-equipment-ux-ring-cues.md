# Equipment UX ring cues

## Systems touched

engine, labs, tests

## Summary

Added explicit `ring1` and `ring2` handling to the empty-slot placeholder path.
The UI probe now exposes the empty-slot cue identity, and the focused
inventory-flow e2e test asserts both ring slots render their intended cues.
The ten-slot contract is unchanged.

## Durable A/B evidence

- Before/main: **2.0/5**, `files/visual-review/before/main/equipment.png`,
  `files/visual-review/before/main/equipment.review.json`
- After/current: **3.0/5**, `files/visual-review/after/v3/equipment.png`,
  `files/visual-review/after/v3/equipment.review.json`
