# Sprite Gallery Lab

Read-only review surface for `npm run sprites:run` outputs. Renders all
runs under `generated/runs/<brief>/<runId>/` as a grid of thumbnails with
anchor-overlay compositing, sensor/judge badges, and a side panel that
shows the full per-candidate scorecard + judge + anchor payloads.

## Running

```bash
# Starts the sidecar (127.0.0.1:3010) and the Vite lab page together.
npm run sprites:gallery
```

Then open `?lab=sprite-gallery` in your browser (the script opens it for
you). The sidecar binds 127.0.0.1 only — never reachable from the LAN.

If the sidecar is not running the lab still loads and shows a banner
explaining how to start it (spec §F9, "review-only mode").

## Keyboard

- `←` / `→` — move between candidates within the focused brief
- `↑` / `↓` — move between briefs
- Click any tile to load its scorecard into the side panel

## Scope

This lab is strictly read-only. The approve / promote flow lives in a
follow-up PR per the spec — there are no mutation buttons or routes
wired up here.
