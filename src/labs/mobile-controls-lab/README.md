# Mobile Controls Lab

Sandbox for iterating on mobile touch controls — virtual joystick, follow-finger movement, and an opaque action button.

## What it tests

- Two movement modes: virtual joystick or follow-finger
- Opaque action button (bottom-right, hit-tested by radius)
- Dead zone tuning — threshold below which joystick input is ignored
- Joystick radius — how far you need to drag for full deflection
- Follow-finger speed and arrival distance
- Mouse-emulated touch — click-drag on desktop to simulate mobile

## How to use

1. `npm run lab` → navigate to `/lab.html?lab=mobile-controls-lab`
2. Touch/click anywhere outside the action button and drag to move
3. Touch/click the red action button (bottom-right) to fire
4. Switch between "joystick" and "follow" modes in the lil-gui dropdown
5. Tune parameters in the settings panel on the right

## Tunable parameters

| Parameter       | Range    | Description                                    |
| --------------- | -------- | ---------------------------------------------- |
| Move Mode       | dropdown | Switch between "joystick" and "follow" modes   |
| Radius          | 30-120px | Joystick: distance for full deflection         |
| Dead Zone       | 0-0.5    | Joystick: magnitude below which output is zero |
| Speed           | 1-15     | Follow: movement speed toward finger           |
| Arrival Dist    | 2-30px   | Follow: distance at which entity stops         |
| Action Btn Size | 50-120px | Visual/hit size of the action button           |
| Action Btn Pad  | 16-80px  | Padding from screen edge                       |
| Debug Overlay   | on/off   | Show/hide numerical readouts                   |
| Haptic Feedback | on/off   | Vibrate on touch start (mobile only)           |
