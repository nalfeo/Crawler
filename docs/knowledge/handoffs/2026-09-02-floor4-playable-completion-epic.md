# Floor 4 playable-completion epic

## Systems touched

ai-combat-balance, mapgen

## Persona

Producer, routing future implementation to QA Engineer, Systems Engineer, Game AI
Engineer, and UX Designer.

## Apples

3🍎 estimated, 3🍎 actual (exact). The session required cross-runner contract research
and a dependency-safe epic, but changed planning artifacts only.

## Outcome

Added the `floor-4-playable-completion` epic as a focused follow-up to the existing,
already-materialized Floor 4 arena epic. Its hard gate is deliberately weaker than a
balance gate: canonical seed 404 must be able to complete Floor 4 with the production
AI in both the real headless pipeline and the visual AI-runner `MainGameScene` path.

The epic first requires an acceptance-criteria document and reproducible baseline,
then orders runtime parity, headless AI completion, and visual AI completion. The
contract forbids direct state mutation, invulnerability, forced kills, injected
spawns, phase skipping, and runner-only gameplay shortcuts. Balance, win-rate sweeps,
economy tuning, achievements, content expansion, and polish are out of scope.

Repository evidence already shows that the act-1 headless wave test observes physical
spawns, despite the reported empty visual run. The baseline slice therefore treats
this as a discrepancy to localize rather than assuming Floor 4 spawning is universally
absent.

## Verification

- Epic JSON formatting and schema checks.
- Documentation checks.
- PR prerequisite checks.

## Next

Human review must approve the generated epic review issue before implementation nodes
materialize. Start with the acceptance/baseline slice; do not begin runtime repair
until it identifies the first failed criterion in each runner.
