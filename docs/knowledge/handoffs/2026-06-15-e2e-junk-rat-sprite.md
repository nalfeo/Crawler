# Handoff: E2E Junk Rat Sprite Generation — 2026-06-15

## Summary

Completed the full junk-rat-critters sprite generation E2E with **real Azure OpenAI** (not mocked).

## Apple Estimate

Declared: 🍎🍎 | Actual: 🍎🍎 — two key blockers (credentials, vision deployment) but pipeline logic was already solid.

## What Was Done

1. **Credential setup** — identified and switched to
   alfeo@hotmail.com (Visual Studio Enterprise sub 308f5463). The project already had scripts/setup-azure-env.ps1 which fetches from oai-crawler-nalfeo in
   g-crawler-sprites. Running it writes .env.local.

2. **Sidecar restart** — restarted sidecar with correct env vars:
   - AZURE_OPENAI_ENDPOINT=https://aoai-crawler-nalfeo.openai.azure.com/
   - AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o
   - AZURE_OPENAI_IMAGE_DEPLOYMENT=gpt-image-1
   - AZURE_OPENAI_VISION_DEPLOYMENT=gpt-4o (needed because synthesized briefs set judge.enabled: true)

3. **E2E script** — scripts/e2e-junk-rat-sprite.mjs exercises:
   - Synthesize brief (gpt-4o, 1 candidate)
   - Promote to briefs/draft/enemies/junk-rat-critters.yaml
   - Generate run (gpt-image-1, 16 candidates, ~50s)
   - Metadata pipeline (heuristic)
   - Playwright gallery check at http://localhost:3002/lab.html?lab=sprite-gallery

4. **Committed** — 944c146 on branch
   alfeo/e2e-junk-rat-gen

## Key Discoveries

- gpt-image-1 generates a **sprite sheet** which is sliced into 16 individual candidates automatically
- Metadata pipeline returns processed: 0 because no candidates have been "approved" (approved = committed to public/assets/generated/). This is correct — metadata syncs only approved sprites.
- The sidecar doesn't auto-load .env.local — credentials must be set in the shell before starting it.
- start-sidecar.bat in session files (C:\Users\nalfeo\.copilot\session-state\73d0de5f...\files\) is a quick restart helper for this session.

## How to Run

`powershell

# 1. Credentials (once per machine)

pwsh scripts/setup-azure-env.ps1

# 2. Load env vars

foreach ( in Get-Content .env.local) {
if ( -match '^([^#=]+)=(.\*)$') { [System.Environment]::SetEnvironmentVariable([1], [2]) }
}
\ = "gpt-image-1"
\ = "gpt-4o"

# 3. Start sidecar + Vite lab

npx tsx scripts/sprites/sidecar/cli.ts &
npx vite --mode lab --port 3002 &

# 4. Run E2E

node scripts/e2e-junk-rat-sprite.mjs
`

## Branch

alfeo/e2e-junk-rat-gen — not yet PR'd
