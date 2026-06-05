# Mobile Controls Lab

Sandbox for iterating on the virtual joystick and action button used on mobile/touch devices.

## What it tests

- Virtual joystick movement (left-half of screen)
- Action button firing (right-half of screen)
- Dead zone tuning — threshold below which input is ignored
- Joystick radius — how far you need to drag for full deflection
- Mouse-emulated touch — click-drag on desktop to simulate mobile

## How to use

1. `npm run lab` → navigate to `?lab=mobile-controls-lab`
2. Touch/click the left half and drag to move the entity
3. Touch/click the right half to trigger the action
4. Adjust dead zone, radius, opacity, and button size via lil-gui controls

## Tunable parameters

| Parameter        | Range    | Description                                  |
| ---------------- | -------- | -------------------------------------------- |
| Joystick Radius  | 30–120px | Distance for full-deflection virtual stick   |
| Dead Zone        | 0–0.5    | Input magnitude below which output is zeroed |
| Action Btn Size  | 40–120px | Visual size of the action button indicator   |
| Control Opacity  | 0.1–1.0  | Transparency of on-screen controls           |
| Debug Overlay    | on/off   | Show/hide numerical readouts                 |
| Haptic Feedback  | on/off   | Vibrate on touch start (mobile only)         |
