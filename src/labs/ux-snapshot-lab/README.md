# UX Snapshot Lab

One screen showing every Floor 1 HUD/UX surface at once so the pixel-UI styling
can be eyeballed and iterated quickly — the UX counterpart to `visual-snapshot-lab`.

## What it shows

- The **real** `HudUI` (not a mock): health bar, XP bar, floor timer, quest
  tracker, and minimap, rendered through the actual Phaser paths.
- The **real** `DialogueBox` (NPC dialogue) and `ModalPickerUI` (choice modal),
  rendered through the actual Phaser paths so their pixel chrome matches the game.
- A representative Floor 1 room (CC0 temp tiles/actors) behind the HUD: walls,
  an open and a closed door, floor variation, an NPC, the hero, a slime, a rat.
- In-world drops with bobbing + ground shadows: XP crystals, coins, a potion.

## How to use

```
npm run lab        # then open ?lab=ux-snapshot-lab
```

lil-gui sliders drive the HUD through its states:

- **HP %** / **Max HP** — health bar fill, low-HP pulse, segment ticks.
- **XP %** / **Level** — experience bar fill.
- **Time left (s)** — floor timer neutral → amber (<60s) → red (<30s, pulses).
- **Active quests** — 0/1/2 quests in the quest tracker.
- **Show dialogue** — toggle the NPC dialogue box.
- **Open choice modal** — open the starter-weapon choice modal.
- **Restart scene** — rebuild the Phaser scene.

The drops and room are static reference art (the production game uses Kenney
sprites); the focus here is the HUD styling and legibility.
