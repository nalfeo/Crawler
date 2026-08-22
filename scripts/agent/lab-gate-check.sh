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
  # Core ability-grant helpers are exercised by the equipment-lab via
  # equipmentSystem (which calls grantGeneratedEquipmentActiveAbilityCore /
  # grantGeneratedEquipmentPassiveAbilityCore / revokeEquipmentAbilityGrantsCore).
  [abilitygranthelpers]="equipment-lab"
  # The family-relationship drain/decay system is exercised by the
  # family-territory-lab (its delta buttons queue + drain relationship deltas).
  [familyrelationship]="family-territory-lab"
  # Floor 3 Companion League combat-XP/evolution/ability-unlock system (slice
  # 5) is exercised by the floor3-companion-lab's "attack rival" action, which
  # drives the real applyDamage -> companionProgressionSystem path and
  # displays the resulting level/form/ability changes.
  [companionprogression]="floor3-companion-lab"
  # enemyTelegraph.ts is a shared resolver/state module (not a per-frame
  # System), called from enemyAISystem's real fire path. enemy-ai-lab already
  # spawns AI_TYPE.RANGED enemy groups, ticks the real enemyAISystem every
  # frame, and renders through createPhaserBridge — the same production
  # PhaserBridge telegraph render cue — so the full start/hold/fire lifecycle
  # is genuinely observable live there.
  [enemytelegraph]="enemy-ai-lab"
)

echo "🔬 Lab Gate Check: Verifying every system has a lab..."

# If no systems directory exists yet, pass
if [ ! -d "$SYSTEMS_DIR" ]; then
  echo "ℹ️  No systems directory yet. Skipping lab gate check."
  exit 0
fi

# Precompute the set of lab base-names ONCE. This used to be an inner loop over
# every lab for every system (O(systems × labs)), and each iteration forked
# basename + sed + tr — pathologically slow on Windows Git Bash, where process
# creation dominates the wall time. Bash parameter expansion (${x##*/}, ${x%-lab},
# ${x,,}) does the same string work with NO subprocesses, and an associative-array
# membership test replaces the inner loop, bringing the whole check to
# O(systems + labs) with a small constant.
declare -A LAB_NAMES=()
for lab_dir in "$LABS_DIR"/*/; do
  [ -d "$lab_dir" ] || continue
  lab_name="${lab_dir%/}"       # strip trailing slash
  lab_name="${lab_name##*/}"    # basename (strip leading path)
  lab_name="${lab_name%-lab}"   # strip "-lab" suffix (matches sed 's/-lab$//')
  lab_name="${lab_name,,}"      # lowercase (matches tr '[:upper:]' '[:lower:]')
  LAB_NAMES["$lab_name"]=1
done

# Find all system files (excluding index.ts)
for system_file in "$SYSTEMS_DIR"/*.ts; do
  [ -f "$system_file" ] || continue

  # Skip index files
  basename="${system_file##*/}"   # basename (strip leading path)
  basename="${basename%.ts}"      # strip .ts extension
  if [ "$basename" = "index" ]; then
    continue
  fi

  # Extract system name (e.g., "movement" from "movementSystem.ts" or "movement.ts")
  system_name="${basename%System}"      # strip trailing "System" (matches sed 's/System$//')
  system_name="${system_name,,}"        # lowercase (matches tr '[:upper:]' '[:lower:]')

  # Check if covered by a shared lab
  if [ -n "${SHARED_LAB_MAP[$system_name]:-}" ]; then
    shared_lab="${SHARED_LAB_MAP[$system_name]}"
    if [ -d "$LABS_DIR/$shared_lab" ]; then
      echo "✅ System '$basename' → covered by $shared_lab"
      continue
    fi
  fi

  # Check for a corresponding lab via O(1) associative-array lookup.
  if [ -n "${LAB_NAMES[$system_name]:-}" ]; then
    echo "✅ System '$basename' → lab found"
  else
    echo "❌ System '$basename' has no lab! Expected: $LABS_DIR/${system_name}-lab/"
    FAILED=1
  fi
done

if [ $FAILED -eq 1 ]; then
  echo ""
  echo "❌ Lab gate check FAILED. Every system in $SYSTEMS_DIR must have a lab in $LABS_DIR."
  echo "   Create the lab before shipping the system."
  exit 1
fi

echo "✅ Lab gate check passed."
