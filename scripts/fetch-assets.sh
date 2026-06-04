#!/usr/bin/env bash
#
# Fetch CC0 sprite asset packs from Kenney.nl into public/assets/.
#
# This script is idempotent — re-running it overwrites the committed
# files with freshly-downloaded copies. The expected SHA-256 of each
# pinned download is verified before any file is written into the repo.
#
# Usage:
#   bash scripts/fetch-assets.sh
#
# The downloads are CC0 (Creative Commons Zero) — no attribution
# required. We include the upstream LICENSE.txt anyway so the source
# is documented inside the repo.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS_DIR="$ROOT/public/assets/kenney"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

log() { printf '[fetch-assets] %s\n' "$*"; }

# --- pack: roguelike-characters --------------------------------------------
#
# Kenney "Roguelike Characters" pack (450 sprites, CC0).
# A 918x203 spritesheet of 16x16 character/equipment tiles with 1px
# spacing between tiles. We commit roguelikeChar_transparent.png as
# spritesheet.png + the upstream license.
#
# https://kenney.nl/assets/roguelike-characters
PACK_URL="https://kenney.nl/media/pages/assets/roguelike-characters/53ffff4133-1729196490/kenney_roguelike-characters.zip"
PACK_SHA256="05c4c0af7326584cfffbbb196571eb9e102981d2033e90e225c5ba8da8771284"
PACK_DEST="$ASSETS_DIR/roguelike-characters"

log "downloading roguelike-characters pack"
ZIP="$TMP_DIR/roguelike-characters.zip"
curl --fail --silent --show-error --location --output "$ZIP" "$PACK_URL"

log "verifying SHA-256"
ACTUAL="$(sha256sum "$ZIP" | awk '{print $1}')"
if [ "$ACTUAL" != "$PACK_SHA256" ]; then
  echo "ERROR: SHA-256 mismatch for roguelike-characters pack." >&2
  echo "  expected: $PACK_SHA256" >&2
  echo "  actual:   $ACTUAL" >&2
  echo "Kenney rotates URLs occasionally. Update PACK_URL and PACK_SHA256" >&2
  echo "in this script after manually verifying the new download." >&2
  exit 1
fi

log "extracting"
EXTRACT="$TMP_DIR/roguelike-characters"
mkdir -p "$EXTRACT"
unzip -q -o "$ZIP" -d "$EXTRACT"

log "installing into $PACK_DEST"
mkdir -p "$PACK_DEST"
cp "$EXTRACT/Spritesheet/roguelikeChar_transparent.png" "$PACK_DEST/spritesheet.png"
cp "$EXTRACT/License.txt" "$PACK_DEST/LICENSE.txt"

log "done"
log "  $PACK_DEST/spritesheet.png ($(wc -c < "$PACK_DEST/spritesheet.png") bytes)"
log "  $PACK_DEST/LICENSE.txt"
