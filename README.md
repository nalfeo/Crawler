# Crawler

A DCC inspired prototype vampire survivor-like.

## 🎮 Play Labs

Try the interactive labs on GitHub Pages: **[nalfeo.github.io/Crawler](https://nalfeo.github.io/Crawler/)**

## Sprite assets

Player + enemy sprites come from [Kenney's CC0 asset packs](https://kenney.nl/).
The committed PNGs live under `public/assets/kenney/`.

To refresh them from the upstream Kenney CDN:

```bash
bash scripts/fetch-assets.sh
```

The script is idempotent and verifies the SHA-256 of each download
before writing into the repo. See `public/assets/kenney/README.md`
for the list of vendored packs.
