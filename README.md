# Crawler

A DCC inspired prototype vampire survivor-like.

## Logging

Crawler uses [`loglevel`](https://github.com/pimterry/loglevel) with scoped loggers (`info`, `warn`, `error`, etc.).

- Default level: `info`
- Configure via env: `VITE_LOG_LEVEL` (browser) or `LOG_LEVEL` (scripts)
- Override in browser query string: `?logLevel=debug`
- Toggle at runtime in the browser console:
  - `window.crawlerLogs.setLevel('debug')`
  - `window.crawlerLogs.getLevel()`

## Play

| Channel   | Link                                                  |
| --------- | ----------------------------------------------------- |
| Release   | [Play](https://nalfeo.github.io/Crawler/)             |
| Beta      | [Play](https://nalfeo.github.io/Crawler/beta/)        |
| Dev       | [Play](https://nalfeo.github.io/Crawler/dev/)         |
| Lab (Dev) | [Open](https://nalfeo.github.io/Crawler/dev/lab.html) |

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
