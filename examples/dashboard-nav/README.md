# dashboard-nav

Navigating a console: sidebar → project list → project detail. The first two
targets are far apart, so the camera reframes; the last two are close, so they
share a shot.

```bash
muse-takeone reconstruct examples/dashboard-nav/input.json -o nav-demo.mp4
```

## What the input does

**Frame 1 (`01-overview.png`)** — the console overview. `click` at (115, 131)
in the sidebar. The camera has to zoom in to make a sidebar icon readable at
1.35×, so this shot frames the left side.

**Frame 2 (`02-projects.png`)** — the project list after the click. The next
`click` at (755, 116) is ~640 px away — far outside the sidebar shot's visual
region. The planner inserts a direct reframe: straight to the new framing,
never zoom-out/zoom-in.

**Frame 3 (`03-detail.png`)** — the project detail, `holdMs: 2400` for the
viewer to read it.

## Camera behavior to watch

`muse-takeone inspect` shows two shots: sidebar, then content. Compare with
form-typing (one shot): the planner groups foci by time *and* by whether one
routine-scale framing covers them. Clicks seconds apart across the viewport
reframe; clicks seconds apart inside one framing don't. After the last focus
the final shot holds, then releases to the full overview at the end of the
take.
