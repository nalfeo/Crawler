# ADR 0109: Floor 5 objective interaction contract

## Status

Accepted — 2026-09-20.

## Context

Floor 5's siege tasks previously completed from elapsed time. The scene could
render HUD text but had no floor-neutral way to offer a scenario-owned, nearby
world interaction for component recovery and Ram authorization.

## Decision

Add the optional `ScenarioInteractionContract` to the shared presentation
contract. The scenario supplies the current nearby action and owns validation
and mutation; `MainGameScene` only displays the ordinary interact hint and
forwards an accepted input. Floor 5 derives objective locations from authored
siege set-piece labels, projects them through existing quest waypoints, and
uses player-attributed hostile deaths plus local position/clearance checks for
combat tasks.

## Consequences

The engine remains floor-agnostic, objective state stays in the existing siege
and quest data paths, and an idle player has no progression route. Future
scenarios may reuse the contract without adding floor branches to the scene.
