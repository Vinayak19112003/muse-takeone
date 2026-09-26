# form-typing

A sign-in flow: click into a username field and type visibly, click into a
password field and type with the key pill hidden, click Sign in, land on the
welcome screen.

```bash
muse-takeone reconstruct examples/form-typing/input.json -o form-demo.mp4
```

## What the input does

**Header** — `source.type` is `manual-screenshots` here because the frames are
synthetic placeholders (see the note in `source`). In a real take this is
`muse-managed-browser` and `screenshotsDir` points at your captured frames.
`viewport` must match the screenshot size.

**Frame 1 (`01-empty.png`)** — the empty form. Two actions:
1. `click` at (640, 378): the cursor glides from its rest position along an
   eased curved path, settles ~120 ms (`preClickMs` default), clicks with a
   ripple, then waits 500 ms (`pauseMs`).
2. `type` at the same point: one key event per character of `demo_user`, with
   deterministic per-character gaps. `showKeys: true` grows the on-screen text
   pill as the characters land — the viewer reads along.

**Frame 2 (`02-username.png`)** — the form with the username filled in. The cut
from frame 1 lands ~200 ms after the last keystroke (`nextFrameAfterMs`
default): the viewer sees typing finish, then the new UI state. The password
field is clicked, then typed with `sensitive: true` — the key pill stays hidden
(the fixture's fake credential `Tr0ub4dor-fake` never appears on screen either).
The input must show *something* there, so the frame would normally show dots —
the pill is off regardless.

**Frame 3 (`03-password.png`)** — filled form. One `click` on the Sign in button.

**Frame 4 (`04-welcome.png`)** — the result state, no actions, `holdMs: 2200`
so the viewer absorbs it.

## Why one camera shot

Run `muse-takeone inspect` on this input: the shot planner reports a single
shot. All four interaction points fall inside one routine-scale (1.35×) framing,
so the camera moves once, settles before the first click, and holds through the
whole flow. A password field 80 px below the username field does not deserve a
reframe.

Swap the synthetic frames for real captures of your own sign-in page, re-ground
the coordinates from your screenshots, keep the credentials fake.
