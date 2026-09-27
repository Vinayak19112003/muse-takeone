---
name: tracereel
description: Turn an AI agent's browser trace into a polished demo video (smooth cursor, click ripples, settled camera shots, crossfades, padded frame). Capture real screenshots from the browser the agent actually drives, describe states and actions in a TraceReel trace, run tracereel reconstruct. Use this whenever the user wants a demo video, product walkthrough, feature clip or launch video built from an agent's browser session, even if they don't name tracereel, and whenever a project has TraceReel traces or a .tracereel bundle.
---

# tracereel

TraceReel turns AI-agent browser traces into polished demo videos. An agent driving a browser live makes jumpy footage, because every pause while the model thinks ends up on camera — and the managed browser (the one actually logged in to the user's accounts) can't be screen-recorded by outside tools at all. So the workflow splits in three:

1. **Capture** — the agent takes real screenshots of each UI state in the browser session it actually drives, and records the actions between them.
2. **Reconstruct** — `tracereel reconstruct` turns the trace into a full recording manifest: eased 60 Hz cursor glides, clicks, typing, settled camera shots.
3. **Render** — the compositor draws the video on its own clock. The footage never waits on the model, and a take can be restyled without capturing again.

The renderer never sees agent identity: each agent's raw trace is normalized through an adapter into Trace Format v1 (`docs/TRACE_FORMAT.md`). Muse is the tested reference integration; adapter-specific capture notes live under `skills/adapters/`.

TraceReel is based on [takeone](https://github.com/atharvadeosthale/takeone) by Atharva Deosthale. The original takeone scenario workflow (drive-your-own-browser recording) is still in the package and documented at the end; everything below is the trace reconstruction workflow, which is the primary use.

## Install and set up

Do this once per machine, before the first reconstruction. Each step is safe to repeat.

**Install from the repository** (TraceReel is not on npm; never `npm i -D takeone` for this workflow — that installs the upstream package without the reconstruction features):

```bash
git clone https://github.com/Vinayak19112003/muse-takeone.git
cd muse-takeone
npm ci
npm run build
```

The CLI is `tracereel` (`takeone` and `muse-takeone` are kept as deprecated aliases). Run it as `node dist/cli.js <command>` from the repo, or link it: `npm link` gives a global `tracereel`.

**Check Node.** `node -v` must be 20 or newer.

**Prepare the machine.** Run `tracereel doctor`. It checks node, ffmpeg, the Chromium renderer, disk space and write permissions. If the Chromium check fails, either set `TRACEREEL_CHROMIUM_PATH` to a system Chrome (avoids the ~650 MB Playwright download) or run `tracereel setup`, which downloads Chromium once. (`TAKEONE_CHROMIUM_PATH` still works as a fallback.)

## The working loop

```
generate → validate --json → repair → inspect --json → repair → render → QA → rerender
```

Generate or hand-write the trace, then validate it machine-readably and repair every error before rendering. `inspect --json` shows what will happen (agent, adapter, states, actions, duration, camera shots, QA). Render, read the QA warning counts, fix what matters, rerender.

## Capture — hard rule

The capture source is **the browser the agent is already driving**. This is not a recommendation; violating it produces a video of the wrong session (e.g. a signed-out page when the real session was logged in).

1. **Use the browser the agent is already driving.** Perform the real workflow there — real clicks, real typing, real page state.
2. **Screenshots must come from that exact browser**: its logged-in state, cookies, account avatar, private pages, scroll position, dialogs, current tab, theme — whatever is actually visible.
3. **Never launch another browser to obtain footage.** Not Playwright, not Puppeteer, not a headless Chromium, not a fresh unauthenticated browser — for the capture stage. TraceReel's own Chromium is allowed for **rendering only**: it draws already-captured screenshots and never browses the target site.
4. **Do not recreate login/session state elsewhere.** No copying cookies into a fresh browser, no logging in elsewhere, no opening the same URL separately. The footage source is the actual agent session.
5. **Ground click coordinates against screenshots from that browser.** Grounded on a different browser's screenshot, the coordinates land on the wrong pixels. Visual-grounding tools typically return 0–1000 normalized coordinates; convert before use: `px = x / 1000 × width`, `py = y / 1000 × height`.
6. **If screenshot extraction is genuinely impossible, stop and report it.** Never silently substitute another browser. A fallback browser needs the user's explicit approval — and then the footage is described as "captured in a fallback browser", never as the agent's session.

Separate the three stages in your head: **CAPTURE** (agent browser: real screenshots, real coordinates, real UI states) → **RECONSTRUCTION** (TraceReel: manifest, timeline, synthetic cursor, camera shots, captions) → **RENDER** (compositor Chromium: renders captured screenshots; never browses the target site).

### Capture workflow

Perform the action in the agent's browser, wait for the UI to settle, capture the actual state, record the coordinates, continue:

```
Agent opens the dashboard in its managed browser (logged in, avatar visible)
  → state "home", capture 01
Agent clicks the repository link
  → wait for the page to settle → state "repo", capture 02, ground the click point on 01
...
build trace.json → tracereel reconstruct → compositor renders the MP4
```

For every action that changes the UI, capture **before** (pre-action state) and **after** (settled result): Follow → Following, Like → Liked, menu button → menu open. Never capture mid-animation unless the animation itself is the point. One UI state per screenshot.

**Cursor removal.** Screenshots usually contain the OS cursor baked in — locate it per frame and paint it out (a ~44 px mask around the tip works; use a tighter polygon where UI sits under the cursor) before rendering, or the video shows two cursors. Verify text near the cursor isn't clipped after removal.

## Reconstruct: the trace format

Trace Format v1 is specified in `docs/TRACE_FORMAT.md`; `schema/reconstruction.schema.json` is the machine-readable contract. The shape — states and actions:

```json
{
  "version": 1,
  "source": { "type": "agent-browser", "agent": "muse", "session": "main" },
  "viewport": { "width": 1919, "height": 992 },
  "screenshotsDir": "frames",
  "states": [
    { "id": "home", "screenshot": "01-open.png", "caption": "Open the repo.", "holdMs": 2000 },
    { "id": "merged", "screenshot": "02-merged.png", "caption": "Merged." }
  ],
  "actions": [
    { "kind": "click", "from": "home", "to": "merged", "x": 1520, "y": 147, "stateDelayMs": 900 }
  ]
}
```

Or build it programmatically:

```ts
import { TraceBuilder } from "tracereel";
const t = new TraceBuilder({ agent: "muse", viewport: { width: 1919, height: 992 } });
const home = t.state("home", "01-open.png", { caption: "Open the repo." });
const merged = t.state("merged", "02-merged.png");
t.click({ from: home, to: merged, x: 1520, y: 147, stateDelayMs: 900 });
const trace = t.build();
```

Action kinds (`click`, `type`, `scroll`, `hover`, `wait`) and their fields are documented in `docs/TRACE_FORMAT.md`. Every action names the state it starts from; name the state it lands on too — a trace where every action has a `to` renders a complete story.

The older frames-with-actions form still works (TraceReel converts it internally), and `muse-managed-browser` provenance from v0.1.x normalizes to `agent-browser` / agent `muse` with a deprecation warning.

`source` is **declarative provenance metadata**, not cryptographic proof. `--require-source muse-managed-browser` keeps working and makes an accidental capture fallback fail loudly instead of silently producing a video from the wrong session:

```bash
tracereel reconstruct trace.json --require-source muse-managed-browser -o demo.mp4
```

## The commands

| command | does |
|---|---|
| `tracereel validate trace.json [--json]` | schema + semantics check: structured codes, JSON paths, suggestions. Fails loudly on errors. |
| `tracereel inspect trace.json [--json]` | agent, adapter, trace form, states, actions, expected duration, planned camera shots, QA. Read this before rendering. |
| `tracereel capabilities [agent] [--json]` | what each agent's traces can express; which integrations are verified vs planned. |
| `tracereel import raw.json --adapter <name> -o demo.tracereel` | normalize an agent's raw trace into a portable bundle (trace + frames + metadata). |
| `tracereel doctor [--json]` | machine readiness: node, ffmpeg, Chromium renderer, disk, write perms. |
| `tracereel reconstruct trace.json -o demo.mp4` | validate → build manifest → render 1080p60 MP4 + contact sheet + QA report. `--keep-work-dir` + `tracereel render <work-dir>` restyles a take without rebuilding. `--width/--height/--fps` for previews. |

`reconstruct` prints a QA line after every render (duration, resolution, clicks, typed chars, transitions, captions, event count) plus warning counts by bucket — camera, timing, missing-state, viewport — with concrete repair hints. No global quality score: the counts are the signal.

## Camera philosophy: SHOT = CAMERA MOVE

The camera is planned in **shots**, not clicks:

- **One settled shot covers several related interactions.** Nearby clicks and typing seconds apart share one framing; the camera moves once, settles before the first interaction, and holds through the UI mutations.
- **Screenshot cuts never move the camera.** A cut plays a short output-time crossfade (default 140 ms); the camera keeps doing whatever it was doing.
- **Reframes are direct.** When the next target leaves the shot's visual region, the camera moves straight to the next shot — never zoom-out, pause, zoom-in.
- **Only the final shot releases** back to the full overview, and only after a real gap.

This is automatic from the action points: no manual zoom keyframes needed. Calmer-than-native defaults apply (`zoom.autoScale` 1.35, no cursor-following, `keys.mode` all). The shot planner (`src/reconstruct/shots.ts`) runs on any manifest with `mode: "reconstructed"` and accepts explicit `shots` to override planning entirely.

## Privacy

- **Local by default.** Reconstruction and rendering happen on your machine. TraceReel never uploads screenshots, traces, or videos.
- **Redact before rendering.** `redactions` blur/pixelate/black-out regions at frame-copy time, so the pixels never reach the compositor or the output video. Inspect the rendered frames before publishing — redaction only hides what the regions cover.
- **Sensitive typing.** `{ "kind": "type", "sensitive": true }` hides the HUD text pill. Still: never type real credentials for a demo; use fake ones.
- Screenshots of a signed-in session can contain names, avatars, messages, tokens. Treat the frames directory like credentials: keep it local, don't commit it.

## Describe the result honestly

Say **"reconstructed from real screenshots"** (real frames, rebuilt cursor path) — never "a captured live recording". Name which browser the screenshots came from. The `source` field is metadata you declare; it does not prove a PNG's origin.

## The original takeone workflow (upstream)

The package also contains the original takeone: rehearse clicks live in its own browser (`tracereel do`), export a TypeScript scenario (`tracereel session export`), dry-run (`tracereel dry-run`), record (`tracereel record`). That workflow drives its own browser and is the right tool when no agent session is involved — e.g. scripted marketing videos of a public page. It is upstream takeone functionality, documented in `references/scenario-api.md`; the reconstruction features above are the TraceReel additions. `tracereel assemble` builds a Ken Burns-style video from stills when no cursor is needed.
