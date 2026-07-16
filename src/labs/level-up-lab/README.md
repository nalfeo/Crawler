# Level-Up Lab

Interactive Phaser sandbox for the level-up stat-allocation overlay
(`src/engine/LevelUpUI.ts`).

## What it tests

- The real `createLevelUpUI` overlay rendering, keyboard navigation, and pointer
  controls (−/+ per stat, Reset, Confirm).
- The pure allocation rules from `src/shared/level-up-allocation.ts` (clamping to
  available points, banking unspent points).
- That confirming an allocation spends points through the real `spendPoints` +
  core `statSystem` pipeline.

## How to use

Run `npm run lab` and open `?lab=level-up-lab`.

- **Points to grant** — how many unspent points the next open grants.
- **Open level-up screen** — (re)opens the overlay, granting another level's
  worth of points if none remain.
- **Restart scene** — rebuilds the Phaser scene from scratch.

In the overlay: `↑/↓` select a stat, `←/→` adjust its allocation, `Enter`
confirms (banking any leftover points), `Esc` cancels (banks everything).
Confirmed allocations are logged to the console with the resulting unspent total.
