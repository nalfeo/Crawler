# Sprite Preview Lab

Visual catalogue of every sprite registered in
`src/engine/sprites/registry.ts`.

Each tile shows:

- The rendered sprite at 4× scale on a checkerboard background
- The logical sprite ID (e.g. `player`, `enemy.goblin`)
- The sheet frame index plus its `(col, row)` position
- An optional human-readable note from the registry

Use this lab to verify that:

- Every registered sprite resolves to the correct frame
- New sprites you add to the registry actually appear
- A sheet loads at all (a red `load error` tile means the
  PNG is missing — re-run `bash scripts/fetch-assets.sh`)

## Run

```bash
npm run lab
# then open ?lab=sprite-preview
```
