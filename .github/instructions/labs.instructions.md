---
applyTo: 'src/labs/**'
---

# Labs Layer Instructions

Labs are development sandboxes for prototyping game systems in isolation.

## Rules

- Labs can import from ANY layer (unrestricted)
- Each lab lives in its own directory: `src/labs/<system-name>-lab/`
- Labs must be discoverable by the lab loader (`src/lab-main.ts`) and register via `registerLab(...)`
- Labs use lil-gui for parameter tuning controls
- Labs should be self-contained — runnable via `?lab=<name>` URL param

## Lab Structure

```
src/labs/<name>-lab/
├── index.ts        # Lab entry point, calls registerLab(...)
└── README.md       # Recommended: what this lab tests, how to use it
```

## Creating a New Lab

1. Create directory in `src/labs/`
2. Add an entry to `LAB_MODULE_PATHS` in `src/lab-main.ts`
3. Call `registerLab(...)` from the lab `index.ts`
4. Add lil-gui controls for tunable parameters
5. Verify it loads via `npm run lab` → `?lab=<name>`

> Labs are intentionally unrestricted. See `docs/README.md` for the governance
> source-of-truth registry and `docs/guides/lab-authoring.md` for the full
> workflow.
