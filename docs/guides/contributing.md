# Contributing Guide

This workflow applies to both agents and humans.

## 1. Start from a fresh branch

- Branch from `main`
- Use one focused branch per task
- Do not push directly to `main`
- Keep branches small enough to review and verify quickly

## 2. Run preflight

At session start run:

```bash
bash scripts/agent/preflight.sh
```

Then load the relevant persona, recent handoffs, and any needed policy or guide docs.

## 3. Make focused changes

- Keep architectural changes aligned with the constitution
- If a decision affects 2+ systems, write or update an ADR
- If you add an ECS system, create its lab as part of the same change

## 4. Use conventional commits

Accepted prefixes:

- `feat:`
- `fix:`
- `chore:`
- `lab:`
- `docs:`
- `refactor:`
- `test:`
- `perf:`
- `ci:`
- `build:`
- `revert:`

Choose the narrowest accurate type.

## 5. Verify fast before push

After every meaningful change run:

```bash
npm run verify:fast
```

This is the minimum bar before pushing branch updates.

## 6. Verify fully before opening or updating a PR

Before a pull request, run:

```bash
npm run verify
bash scripts/agent/lab-gate-check.sh
```

If the change adds or touches an ECS system, the lab gate is mandatory.

## 7. Open a reviewable PR

Before requesting review:

- make sure the branch is up to date with `main`
- ensure CI passes deterministically
- use a semantic PR title consistent with the conventional commit family
- keep the PR scoped so reviewers can understand intent quickly

## 8. Follow the handoff protocol

Before ending the session, write a handoff in `docs/knowledge/handoffs/`.

Include at least:

- what changed
- files touched
- commands run for verification
- open risks or follow-ups
- the recommended next action

## 9. Special rule: lab gate

No ECS system ships without a corresponding lab in `src/labs/`.

If the lab does not exist, the work is not done.
