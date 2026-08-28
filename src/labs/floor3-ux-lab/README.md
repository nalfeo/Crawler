# Floor 3 UX Lab

Sandbox for the Floor 3 Companion League onboarding surfaces (spec slice 12 /
game-design §15 UX surfaces #1–#3):

1. **Welcome + rules briefing** — show format, "you don't fight", recruit and
   party-lock rules, win condition.
2. **Starter picker** — the seeded 4-species offer with affinity · style ·
   innate ability.
3. **Trainer-poach picker** — a defeated Trainer's roster, the recruit slots
   left, and the party-lock warning on the pick that signs the roster.

Run it with `npm run lab` → `?lab=floor3-ux-lab`.

## Controls

| Control              | Effect                                                            |
| -------------------- | ----------------------------------------------------------------- |
| Offer seed           | Seeds the starter/poach offers (same seed ⇒ same species + order) |
| Slots remaining      | Recruit slots left; set to **1** to show the party-lock warning   |
| Trainer roster level | Level the poach candidates are shown (and would be recruited) at  |
| Open … (#1/#2/#3)    | Opens that surface in the real `ModalPickerUI`                    |

The lab renders the same `src/shared/floor3-ux.ts` presentation models that
`MainGameScene` uses, so copy shown here is the copy the game ships. The lab
is a presentation sandbox only — the real recruiting/pause wiring lives in
`floor3Scenario.ts` and is exercised in the game and headless pipelines.
