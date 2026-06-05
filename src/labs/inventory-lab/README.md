# Inventory Lab

Sandbox for developing and testing the inventory system UX.

## What it tests

- Dynamic tab system (tabs appear/disappear as items are picked up)
- Search filtering
- Sort modes (rarity, name, quantity)
- Stack behavior
- Tooltip display
- Tab preferences (reorder/hide custom tabs)
- Rarity color coding

## How to use

1. `npm run lab` → navigate to `?lab=inventory-lab`
2. Use lil-gui controls to spawn items, adjust quantities
3. Walk the player over dropped items to test auto-pickup
4. Press Tab or I to toggle the inventory panel
5. Click tabs, type to search, hover for tooltips

## Controls

| Control       | Action                          |
| ------------- | ------------------------------- |
| WASD / Arrows | Move player                     |
| Tab / I       | Toggle inventory                |
| lil-gui       | Spawn items, control spawn rate |
