#!/usr/bin/env bash
set -euo pipefail

SYSTEMS_DIR="src/core/systems"
LABS_DIR="src/labs"
FAILED=0

# Systems covered by a shared lab (e.g., weapon-lab covers all weapon-type systems)
declare -A SHARED_LAB_MAP=(
  [beam]="weapon-lab"
  [meleeswing]="weapon-lab"
  [trap]="weapon-lab"
  [aoeonimpact]="weapon-lab"
  [areadamage]="weapon-lab"
  [returningprojectile]="weapon-lab"
  # DeathTimer is post-death cleanup (counts down before removeEntity),
  # exercised through the health-lab death-flow scenarios.
  [deathtimer]="health-lab"
  # Achievement reward claim helpers are reveal-only state, exercised by the
  # achievements-ui-lab (unlock → open reward → marked claimed).
  [achievementrewards]="achievements-ui-lab"
  # The family-relationship drain/decay system is exercised by the
  # family-territory-lab (its delta buttons queue + drain relationship deltas).
  [familyrelationship]="family-territory-lab"
)

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
  
  # Check if covered by a shared lab
  if [ -n "${SHARED_LAB_MAP[$system_name]:-}" ]; then
    shared_lab="${SHARED_LAB_MAP[$system_name]}"
    if [ -d "$LABS_DIR/$shared_lab" ]; then
      echo "✅ System '$basename' → covered by $shared_lab"
      continue
    fi
  fi

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
