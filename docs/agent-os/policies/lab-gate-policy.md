# Lab Gate Policy

## Policy

Every ECS system in `src/core/systems/` must have a corresponding lab in `src/labs/` before it is considered shippable.

## Required Mapping

- System files in `src/core/systems/` map to lab directories in `src/labs/`
- Use the naming convention `<system>-lab/`
- A system is incomplete until its lab exists and loads successfully

## Required Lab Structure

Each lab directory must contain:

```text
src/labs/<system>-lab/
├── index.ts
├── config.ts
└── README.md
```

## Lab Requirements

- Labs use **lil-gui** for parameter tuning and rapid balance iteration.
- Labs must be self-contained and runnable without depending on hidden editor state.
- Labs must be loadable through the lab entry point via `?lab=<name>`.
- Labs may import across layers when needed, but they exist to exercise a specific system clearly.
- `README.md` explains purpose, controls, and the expected observations.

## Framework Registration

- Register every new lab in the lab framework registry used by `src/lab-main.ts`.
- The registry entry must expose a stable lab name that matches the `?lab=<name>` URL value.
- Do not leave orphaned lab folders that are not reachable from the framework.

## CI Enforcement

CI enforces this policy with:

```bash
bash scripts/agent/lab-gate-check.sh
```

The check fails if a system in `src/core/systems/` has no matching lab directory in `src/labs/`.

## Shipping Rule

If the lab is missing, the system does not ship.
