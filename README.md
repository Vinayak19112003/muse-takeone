# muse-takeone

Polished demo videos made by Muse, from Muse's own browser. Smooth cursor, click ripples, settled camera shots, crossfades, and the padded Screen Studio frame — rendered at 1080p, 60 fps.

This is a fork of [takeone](https://github.com/atharvadeosthale/takeone), rebuilt around the way Muse works. An agent driving a browser live makes jumpy footage, because every pause while the model thinks ends up on camera. And Muse's managed browser — the one that's actually logged in to your accounts — can't be screen-recorded by outside tools at all.

So muse-takeone splits the job the way Muse actually operates:

1. **Muse captures.** Screenshots are taken from the exact managed browser session that's signed in — real logged-in state, no fresh headless browser pretending to be you.
2. **Muse reconstructs.** `takeone reconstruct` turns those screenshots plus an action script into a full recording manifest: eased 60 Hz cursor glides, clicks, typing, and settled camera shots planned around what you're doing.
3. **TakeOne renders.** The real compositor draws the video on its own clock — the footage never waits on the model, and you can restyle a take without capturing again.

## Quick start

```bash
git clone https://github.com/Vinayak19112003/muse-takeone.git
cd muse-takeone
npm install
npm run build
```

The bundled skill teaches Muse the whole workflow:

```bash
npx skills add Vinayak19112003/muse-takeone
```

### The Muse workflow: capture → reconstruct → render

Capture one screenshot per stage from the managed browser session (it's already logged in — that's the point). Then describe what happened:

```bash
takeone reconstruct input.json -o demo.mp4
```

`input.json`:

```json
{
  "source": { "type": "muse-managed-browser", "session": "main" },
  "viewport": { "width": 1919, "height": 992 },
  "screenshotsDir": "frames",
  "frames": [
    {
      "file": "01-open.png",
      "holdMs": 3000,
      "caption": "Open the repo",
      "actions": [
        { "kind": "click", "x": 1520, "y": 147, "pauseMs": 900 },
        { "kind": "click", "x": 300, "y": 700 }
      ]
    },
    {
      "file": "02-merged.png",
      "holdMs": 2600,
      "caption": "Merged",
      "actions": [{ "kind": "type", "x": 800, "y": 450, "text": "shipped" }]
    }
  ]
}
```

Actions run in order while their frame is up: the cursor glides along an eased curved path to each target, clicks, or types. If the actions take longer than `holdMs`, the frame extends automatically.

The `source` field records provenance. Pass `--require-source muse-managed-browser` and the build fails loudly if the input wasn't captured from Muse's managed browser — no silent fresh-Chromium footage, ever:

```bash
takeone reconstruct input.json --require-source muse-managed-browser -o demo.mp4
```

**Camera philosophy: SHOT = CAMERA MOVE.** Reconstructed mode plans the camera in settled shots, not clicks. Nearby interactions share one framing — the camera moves once, settles before the first click, and holds through the UI mutations. Screenshot cuts never move the camera; each cut plays a short output-time crossfade. When the next target leaves the shot's visual region, the camera reframes directly into the next shot — never zoom-out, pause, zoom-in. Only the final shot releases back to the overview.

Notes from practice:

- Ground every click target from its own screenshot instead of hand-placing it. Visual-grounding tools typically return 0–1000 normalized coordinates, so convert before use: `px = x / 1000 × width`, `py = y / 1000 × height`.
- Screenshots usually contain the OS cursor baked in — locate it per frame and paint it out (a ~44px mask around the tip works; use a tighter polygon where UI sits under the cursor) before rendering, or the video shows two cursors.
- Settle the page before each screenshot: a shot taken mid-animation bakes the animation into a still, and the crossfade then looks like a glitch. One UI state per screenshot — the post-click shot must show the post-click page.
- `keys.mode: "all"` (already the reconstruction default) shows typed characters as a growing pill, which reads as live typing over an empty text field.
- Point takeone at a system Chrome to skip the ~650MB Playwright download at render time: `TAKEONE_CHROMIUM_PATH=/opt/meta-chromium/chrome takeone reconstruct …`.
- The render is deterministic: the same input always produces the same video. Crossfades are measured in output time and every frame names its own images, so parallel workers can't disagree. Use `--keep-work-dir` and `takeone render <work-dir>` to restyle a take without rebuilding it.
- Before calling a render done: confirm specs with ffprobe, extract frames mid-cut to see the blend actually playing, spot-check click moments for cursor-on-target, and scan for double cursors or inpainting damage.
- Describe the result honestly as reconstructed from real screenshots (real frames, rebuilt cursor path), never as a captured live recording.

**Advanced:** `reconstruct` writes a plain `manifest.json` with `mode: "reconstructed"` into its working dir. You can hand-build or tweak that manifest instead — the shot planner (`src/reconstruct/shots.ts`) runs on any manifest with the mode set, and accepts explicit `shots` to override the planning entirely. Calmer-than-native defaults live in `RECONSTRUCTION_DEFAULTS` (`src/config.ts`).

## Everything else takeone does

The original takeone workflow is fully intact for agents that drive their own browser:

- **Rehearse & record** — `takeone do` drives a live browser step by step, `session export` turns the rehearsal into a TypeScript scenario, `record` renders it. Targets name what an element is (`{ role, name }`), not where it sits in the DOM.
- **Scenarios** — the export is a plain TypeScript file you can edit by hand. Full API in [`skills/takeone/references/scenario-api.md`](skills/takeone/references/scenario-api.md).
- **Assemble** — `takeone assemble ./frames` builds a polished video from still screenshots with Ken Burns motion, caption bars, fades, and an optional title card. For footage that needs motion but not a cursor.
- **MCP server** — `npx -y takeone mcp` gives agents screenshot-carrying tool calls; shares one browser with the CLI.
- **The look** — capture and output configured separately. Default: 1920x1080 capture at 2x, 1080p 60 fps H.264 output, padded frame, large cursor with click ripples, eased auto-zoom.

```bash
npm i -D takeone
npx takeone setup   # downloads Chromium once (~650 MB), checks ffmpeg
```

## How it works

Playwright drives headless Chromium. Frames come from the DevTools screencast at full resolution, and every pointer move, click, key press, scroll, zoom and wait goes into a `manifest.json`. The compositor renders the video from that log, split across several browser workers that each encode a segment with ffmpeg. The cursor path and camera moves are computed from the log, not from the capture, so they stay smooth even when the page stutters. Output is H.264 MP4 by default, or VP9 WebM.

Limitations: web apps only; pages that repaint faster than the screencast can encode may drop frames (cursor and camera unaffected); headless Chromium has no GPU, so heavy WebGL renders slowly.

## License

MIT
