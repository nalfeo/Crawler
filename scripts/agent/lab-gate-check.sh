#!/usr/bin/env bash
set -euo pipefail

SYSTEMS_DIR="src/core/systems"
LABS_DIR="src/labs"
FAILED=0

echo "🔬 Lab Gate Check: Verifying every system has a lab..."

# If no systems directory exists yet, pass
if [ ! -d "$SYSTEMS_DIR" ]; then
  echo "ℹ️  No systems directory yet. Skipping lab gate check."
  exit 0
fi

# Find all system files (excluding index.ts)
for system_file in "$SYSTEMS_DIR"/*.ts; do
  [ -f "$system_file" ] || continue
  
  # Skip index files
  basename=$(basename "$system_file" .ts)
  if [ "$basename" = "index" ]; then
    continue
  fi
  
  # Extract system name (e.g., "movement" from "movementSystem.ts" or "movement.ts")
  system_name=$(echo "$basename" | sed 's/System$//' | tr '[:upper:]' '[:lower:]')
  
  # Check for a corresponding lab directory
  lab_found=false
  for lab_dir in "$LABS_DIR"/*/; do
    [ -d "$lab_dir" ] || continue
    lab_name=$(basename "$lab_dir" | sed 's/-lab$//' | tr '[:upper:]' '[:lower:]')
    if [ "$lab_name" = "$system_name" ]; then
      lab_found=true
      break
    fi
  done
  
  if [ "$lab_found" = false ]; then
    echo "❌ System '$basename' has no lab! Expected: $LABS_DIR/${system_name}-lab/"
    FAILED=1
  else
    echo "✅ System '$basename' → lab found"
  fi
done

if [ $FAILED -eq 1 ]; then
  echo ""
  echo "❌ Lab gate check FAILED. Every system in $SYSTEMS_DIR must have a lab in $LABS_DIR."
  echo "   Create the lab before shipping the system."
  exit 1
fi

echo "✅ Lab gate check passed."
