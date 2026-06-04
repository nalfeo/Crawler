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
#
# Adding a pack:
#   1. Append a row to the PACKS array below.
#   2. Run the script. SHA-256 mismatch is hard-fail so the URL is
#      treated as immutable; if Kenney rotates the URL, update both
#      fields after manually verifying the new ZIP.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS_DIR="$ROOT/public/assets/kenney"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

log() { printf '[fetch-assets] %s\n' "$*"; }

# Format: name | URL | SHA256 | sheet_path_in_zip | extras_glob (space-separated, optional)
# `sheet_path_in_zip` is the path inside the extracted ZIP that should
# be copied to "$ASSETS_DIR/<name>/spritesheet.png". License.txt is
# always copied. `extras_glob` lists additional files to copy verbatim.
PACKS=(
  "roguelike-characters|https://kenney.nl/media/pages/assets/roguelike-characters/53ffff4133-1729196490/kenney_roguelike-characters.zip|05c4c0af7326584cfffbbb196571eb9e102981d2033e90e225c5ba8da8771284|Spritesheet/roguelikeChar_transparent.png|"
  "tiny-dungeon|https://kenney.nl/media/pages/assets/tiny-dungeon/f8422efb44-1674742415/kenney_tiny-dungeon.zip|c109438ab06f65fd80f9b2686a4cf9c7c11dc64444b47333ec71d602f8bb5fc7|Tilemap/tilemap.png|Tilesheet.txt"
  "tiny-town|https://kenney.nl/media/pages/assets/tiny-town/a415fbeb49-1735736916/kenney_tiny-town.zip|9768692dccff1d706408a5aedd6ca4f6cd1409506cbc84cb2f862919764be977|Tilemap/tilemap.png|Tilesheet.txt"
  "tiny-battle|https://kenney.nl/media/pages/assets/tiny-battle/c1c25ac1f3-1691487575/kenney_tiny-battle.zip|7751ec7d9a07e57baa9fa1174d6f78fcd779a050377227afee77993c73cb5f9e|Tilemap/tilemap.png|Tilesheet.txt"
  "tiny-ski|https://kenney.nl/media/pages/assets/tiny-ski/22e4573b88-1680201514/kenney_tiny-ski.zip|e4fd3ce4658796d905e5bf619be5a81370e681036581de0a51b73fa06e3aaada|Tilemap/tilemap.png|Tilesheet.txt"
  "roguelike-rpg-pack|https://kenney.nl/media/pages/assets/roguelike-rpg-pack/12c03cd78b-1677697420/kenney_roguelike-rpg-pack.zip|8e7d2378f8f794245645f6d7dc7aeeb246791410a7e512293c594b46a5a9524b|Spritesheet/roguelikeSheet_transparent.png|"
)

fetch_pack() {
  local name="$1" url="$2" sha="$3" sheet="$4" extras="$5"
  local dest="$ASSETS_DIR/$name"
  local zip="$TMP_DIR/$name.zip"
  local extract="$TMP_DIR/$name"

  log "downloading $name pack"
  curl --fail --silent --show-error --location --output "$zip" "$url"

  log "verifying SHA-256"
  local actual
  actual="$(sha256sum "$zip" | awk '{print $1}')"
  if [ "$actual" != "$sha" ]; then
    echo "ERROR: SHA-256 mismatch for $name pack." >&2
    echo "  expected: $sha" >&2
    echo "  actual:   $actual" >&2
    echo "Kenney rotates URLs occasionally. Update the row in PACKS" >&2
    echo "after manually verifying the new download." >&2
    exit 1
  fi

  log "extracting"
  mkdir -p "$extract"
  unzip -q -o "$zip" -d "$extract"

  log "installing into $dest"
  mkdir -p "$dest"
  cp "$extract/$sheet" "$dest/spritesheet.png"
  # License.txt is shipped at the ZIP root in every Kenney pack.
  cp "$extract/License.txt" "$dest/LICENSE.txt"
  if [ -n "$extras" ]; then
    for extra in $extras; do
      if [ -e "$extract/$extra" ]; then
        cp "$extract/$extra" "$dest/$(basename "$extra")"
      fi
    done
  fi

  log "  $dest/spritesheet.png ($(wc -c < "$dest/spritesheet.png") bytes)"
}

for entry in "${PACKS[@]}"; do
  IFS='|' read -r name url sha sheet extras <<<"$entry"
  fetch_pack "$name" "$url" "$sha" "$sheet" "$extras"
done

log "done"
