---
name: muse-takeone
description: Turn a workflow performed in Muse's managed browser into a polished demo video (smooth cursor, click ripples, settled camera shots, crossfades, padded frame). Capture real screenshots from the managed session, describe the clicks/types/scrolls in a JSON input, run muse-takeone reconstruct. Use this whenever the user wants a demo video, product walkthrough, feature clip or launch video built from Muse's own browser, even if they don't name muse-takeone, and whenever a project has muse-takeone reconstruction inputs or a .reconstruct folder.
---

# muse-takeone

muse-takeone turns workflows performed in **Muse's managed browser** into polished demo videos. An agent driving a browser live makes jumpy footage, because every pause while the model thinks ends up on camera — and the managed browser (the one actually logged in to the user's accounts) can't be screen-recorded by outside tools at all. So the workflow splits in three:

1. **Capture** — Muse takes real screenshots of each stage in the managed browser session.
2. **Reconstruct** — `muse-takeone reconstruct` turns screenshots + an action script into a full recording manifest: eased 60 Hz cursor glides, clicks, typing, settled camera shots.
3. **Render** — TakeOne's real compositor draws the video on its own clock. The footage never waits on the model, and a take can be restyled without capturing again.

muse-takeone is based on [takeone](https://github.com/atharvadeosthale/takeone) by Atharva Deosthale. The original takeone scenario workflow (drive-your-own-browser recording) is still in the package and documented at the end; everything below is the Muse reconstruction workflow, which is the primary use.

## Install and set up

Do this once per machine, before the first reconstruction. Each step is safe to repeat.

**Install from the repository** (muse-takeone is not on npm; never `npm i -D takeone` for this workflow — that installs the upstream package without the reconstruction features):

```bash
git clone https://github.com/Vinayak19112003/muse-takeone.git
cd muse-takeone
npm ci
npm run build
```

The CLI is `muse-takeone` (a `takeone` alias is kept for compatibility). Run it as `node dist/cli.js <command>` from the repo, or link it: `npm link` gives a global `muse-takeone`.

**Check Node.** `node -v` must be 20 or newer.

**Prepare the machine.** Run `muse-takeone doctor`. It checks node, ffmpeg, the Chromium renderer, disk space and write permissions. If the Chromium check fails, either set `TAKEONE_CHROMIUM_PATH` to a system Chrome (avoids the ~650 MB Playwright download) or run `muse-takeone setup`, which downloads Chromium once.

## Capture: the managed browser — hard rule

The capture source is **the browser Muse is already driving**. This is not a recommendation; violating it produces a video of the wrong session (e.g. a signed-out page when the real session was logged in).

1. **Use the browser Muse is already driving.** Perform the real workflow there — real clicks, real typing, real page state.
2. **Screenshots must come from that exact browser**: its logged-in state, cookies, account avatar, private pages, scroll position, dialogs, current tab, theme — whatever is actually visible.
3. **Never launch another browser to obtain footage.** Not Playwright, not Puppeteer, not a headless Chromium, not a fresh unauthenticated browser — for the capture stage. TakeOne's own Chromium is allowed for **rendering only**: it draws already-captured screenshots and never browses the target site.
4. **Do not recreate login/session state elsewhere.** No copying cookies into a fresh browser, no logging in elsewhere, no opening the same URL separately. The footage source is the actual managed session.
5. **Ground click coordinates against screenshots from that browser.** Grounded on a different browser's screenshot, the coordinates land on the wrong pixels. Visual-grounding tools typically return 0–1000 normalized coordinates; convert before use: `px = x / 1000 × width`, `py = y / 1000 × height`.
6. **If screenshot extraction is genuinely impossible, stop and report it.** Never silently substitute another browser. A fallback browser needs the user's explicit approval — and then the footage is described as "captured in a fallback browser", never "captured from the Muse managed browser".

Separate the three stages in your head: **CAPTURE** (managed browser: real screenshots, real coordinates, real UI states) → **RECONSTRUCTION** (muse-takeone: manifest, timeline, synthetic cursor, camera shots, captions) → **RENDER** (compositor Chromium: renders captured screenshots; never browses the target site).

### Capture workflow

Perform the action in the main browser, wait for the UI to settle, capture the actual state, record the coordinates, continue:

```
Muse opens GitHub in the main managed browser (logged in, avatar visible)
  → capture 01
Muse clicks the repository link
  → wait for the page to settle → capture 02, ground the click point on 01
Muse clicks src/
  → wait for settle → capture 03, ground the click point on 02
...
build input.json → muse-takeone reconstruct → compositor renders the MP4
```

For every action that changes the UI, capture **before** (pre-action state) and **after** (settled result): Follow → Following, Like → Liked, menu button → menu open. Never capture mid-animation unless the animation itself is the point. One UI state per screenshot.

**Cursor removal.** Screenshots usually contain the OS cursor baked in — locate it per frame and paint it out (a ~44 px mask around the tip works; use a tighter polygon where UI sits under the cursor) before rendering, or the video shows two cursors. Verify text near the cursor isn't clipped after removal.

## Reconstruct: the input format

`schema/reconstruction.schema.json` is the machine-readable contract (version 1). The shape:

```json
{
  "version": 1,
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
        { "kind": "type", "x": 800, "y": 450, "text": "hello world", "showKeys": true }
      ]
    },
    { "file": "02-merged.png", "caption": "Merged" }
  ]
}
```

Actions (run in order while their frame is up):

| kind | does |
|---|---|
| `click` | eased cursor glide to the target, small settle, click with ripple. `double: true` double-clicks. Timing: `preClickMs`, `clickHoldMs`, `pauseMs`, `nextFrameAfterMs`. |
| `type` | per-character key events with deterministic jitter; the HUD shows a growing text pill (`showKeys`, default true). `sensitive: true` hides the pill. Never put real secrets in an example — use fake credentials. |
| `scroll` | cursor glides to the point and a scroll marker fires; the *next* frame auto-slides in from the scroll direction unless its `transitionIn` is set. |
| `hover` | cursor glides, rests ~1.6 s, leaves a marker — never clicks. Becomes a camera focus. |
| `wait` | explicit beat; advances the timeline with no cursor movement. Use for storytelling pauses. |

Frame fields: `holdMs` (minimum on-screen time; the frame extends automatically if actions run longer), `caption`, `transitionIn` (`"crossfade"` default, `"cut"`, or `{ "kind": "slide", "dx", "dy" }`).

Top-level: `redactions` (global `[{ x, y, width, height, mode: "blur"|"solid"|"pixelate" }]` applied at copy time via ffmpeg; a frame can add its own `redactions`), `motion` (cursor glide tuning), `output` (size/fps overrides), `source`.

`source.type` is **declarative provenance metadata**, not cryptographic proof: `muse-managed-browser` (the managed session), `external-browser`, or `manual-screenshots`. It is preserved verbatim in the manifest and never affects rendering. `--require-source muse-managed-browser` makes an accidental capture fallback fail loudly instead of silently producing a video from the wrong session:

```bash
muse-takeone reconstruct input.json --require-source muse-managed-browser -o demo.mp4
```

## The commands

| command | does |
|---|---|
| `muse-takeone validate input.json` | schema + semantics check: missing files, bad coordinates, bad timing, provenance mismatch. Fails loudly; warnings go to stderr. |
| `muse-takeone inspect input.json` | human summary: source, frames, action counts, expected duration, planned camera shots, QA warnings. Read this before rendering. |
| `muse-takeone doctor [--json]` | machine readiness: node, ffmpeg, Chromium renderer, disk, write perms. |
| `muse-takeone reconstruct input.json -o demo.mp4` | validate → build manifest → render 1080p60 MP4 + contact sheet + QA report. `--keep-work-dir` + `muse-takeone render <work-dir>` restyles a take without rebuilding. `--width/--height/--fps` for previews. |

`reconstruct` prints a QA line after every render (duration, resolution, clicks, typed chars, transitions, captions, event count) plus warnings: aggressive zoom, rapid camera reversal, clicks landing mid-reframe, frames lingering after their action.

## Camera philosophy: SHOT = CAMERA MOVE

The camera is planned in **shots**, not clicks:

- **One settled shot covers several related interactions.** Nearby clicks and typing seconds apart share one framing; the camera moves once, settles before the first interaction, and holds through the UI mutations.
- **Screenshot cuts never move the camera.** A cut plays a short output-time crossfade (default 140 ms); the camera keeps doing whatever it was doing.
- **Reframes are direct.** When the next target leaves the shot's visual region, the camera moves straight to the next shot — never zoom-out, pause, zoom-in.
- **Only the final shot releases** back to the full overview, and only after a real gap.

This is automatic from the action points: no manual zoom keyframes needed. Calmer-than-native defaults apply (`zoom.autoScale` 1.35, no cursor-following, `keys.mode` all). The shot planner (`src/reconstruct/shots.ts`) runs on any manifest with `mode: "reconstructed"` and accepts explicit `shots` to override planning entirely.

## Privacy

- **Redact before rendering.** `redactions` blur/pixelate/black-out regions at frame-copy time, so the pixels never reach the compositor or the output video. Inspect the rendered frames before publishing — redaction only hides what the regions cover.
- **Sensitive typing.** `{ "kind": "type", "sensitive": true }` hides the HUD text pill. Still: never type real credentials for a demo; use fake ones.
- Screenshots of a signed-in session can contain names, avatars, messages, tokens. Treat the frames directory like credentials: keep it local, don't commit it.

## Describe the result honestly

Say **"reconstructed from real screenshots"** (real frames, rebuilt cursor path) — never "a captured live recording". Name which browser the screenshots came from. The `source` field is metadata you declare; it does not prove a PNG's origin.

## The original takeone workflow (upstream)

The package also contains the original takeone: rehearse clicks live in its own browser (`muse-takeone do`), export a TypeScript scenario (`muse-takeone session export`), dry-run (`muse-takeone dry-run`), record (`muse-takeone record`). That workflow drives its own browser and is the right tool when Muse is *not* the one performing the workflow — e.g. scripted marketing videos of a public page. It is upstream takeone functionality, documented in `references/scenario-api.md`; the reconstruction features above are the muse-takeone additions. `muse-takeone assemble` builds a Ken Burns-style video from stills when no cursor is needed.
