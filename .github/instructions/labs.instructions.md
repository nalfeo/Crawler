---
applyTo: 'src/labs/**'
---

# Labs Layer Instructions

Labs are development sandboxes for prototyping game systems in isolation.

## Rules

- Labs can import from ANY layer (unrestricted)
- Each lab lives in its own directory: `src/labs/<system-name>-lab/`
- Labs must be registered in the lab framework registry
- Labs use lil-gui for parameter tuning controls
- Labs should be self-contained — runnable via `?lab=<name>` URL param

## Lab Structure

```
src/labs/<name>-lab/
├── index.ts        # Lab entry point, registered in lab framework
├── config.ts       # lil-gui parameter definitions
└── README.md       # What this lab tests, how to use it
```

## Creating a New Lab

1. Create directory in `src/labs/`
2. Register in lab framework (src/labs/\_framework/)
3. Add lil-gui controls for tunable parameters
4. Verify it loads via `npm run lab` → `?lab=<name>`
