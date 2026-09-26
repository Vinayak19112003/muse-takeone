# muse-takeone

Polished demo videos made by Muse, from Muse's own browser. Smooth cursor, click ripples, settled camera shots, crossfades, and the padded Screen Studio frame — rendered at 1080p, 60 fps.

Muse drives a browser live, and live agent footage is jumpy: every pause while the model thinks ends up on camera. And Muse's managed browser — the one that's actually logged in to your accounts — can't be screen-recorded by outside tools at all. So muse-takeone splits the job the way Muse actually operates:

1. **Capture** — Muse takes real screenshots of each stage in the managed browser session (real logged-in state, no fresh headless browser pretending to be you).
2. **Reconstruct** — `muse-takeone reconstruct` turns those screenshots plus an action script into a full recording manifest: eased 60 Hz cursor glides, clicks, typing, settled camera shots.
3. **Render** — TakeOne's real compositor draws the video on its own clock. The footage never waits on the model, and a take can be restyled without capturing again.

## Install

muse-takeone installs from this repository (it is not published to npm):

```bash
git clone https://github.com/Vinayak19112003/muse-takeone.git
cd muse-takeone
npm ci
npm run build
```

Then check the machine: `node dist/cli.js doctor` (node ≥ 20, ffmpeg, a Chromium renderer, disk space). The CLI binary is `muse-takeone`; a `takeone` alias is kept for compatibility. `npm link` gives you a global `muse-takeone`.

The bundled skill teaches Muse the whole workflow — see [`skills/muse-takeone/SKILL.md`](skills/muse-takeone/SKILL.md).

## The workflow

Capture one screenshot per stage from the managed browser session (it's already logged in — that's the point). Ground every click target from its own screenshot. Then describe what happened:

```bash
muse-takeone validate input.json   # schema + semantics check
muse-takeone inspect input.json    # what will happen: shots, timing, warnings
muse-takeone reconstruct input.json --require-source muse-managed-browser -o demo.mp4
```

`input.json`:

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

Actions (`click`, `type`, `scroll`, `hover`, `wait`) run in order while their frame is up. The cursor glides along an eased curved path, clicks with a ripple, or types with a growing key pill. The full input contract lives in [`schema/reconstruction.schema.json`](schema/reconstruction.schema.json); annotated examples in [`examples/`](examples/).

**Capture rules that matter:**

- The screenshots must come from **the browser Muse is already driving** — its logged-in state, cookies, avatar, theme. Never launch another browser to obtain footage; TakeOne's Chromium is for **rendering only** and never browses the target site.
- One UI state per screenshot: capture before *and* after every UI-changing action, settled, never mid-animation.
- Screenshots usually contain the OS cursor baked in — paint it out per frame before rendering, or the video shows two cursors.
- `source.type` is **declarative provenance metadata** (`muse-managed-browser` | `external-browser` | `manual-screenshots`), not cryptographic proof. `--require-source muse-managed-browser` fails loudly if the input wasn't captured from the managed browser — no silent fresh-Chromium footage, ever.

**Camera philosophy: SHOT = CAMERA MOVE.** The camera is planned in settled shots, not clicks. Nearby interactions share one framing; cuts never move the camera (short output-time crossfade); reframes are direct, never zoom-out/zoom-in; only the final shot releases to the overview. See [`docs/architecture.md`](docs/architecture.md).

**Privacy.** Redact regions at copy time (`redactions: [{ x, y, width, height, mode: "blur" | "solid" | "pixelate" }]`) — the pixels never reach the video. `{ "kind": "type", "sensitive": true }` hides the key pill. Never type real credentials for a demo; use fake ones. Treat the frames directory like credentials.

**Describe the result honestly:** "reconstructed from real screenshots" (real frames, rebuilt cursor path) — never "a captured live recording". See [`docs/limitations.md`](docs/limitations.md).

## CLI reference

| command | does |
|---|---|
| `muse-takeone validate input.json` | schema + semantics check (missing files, bad coordinates/timing, provenance mismatch) |
| `muse-takeone inspect input.json` | summary: source, frames, actions, expected duration, camera shots, QA warnings |
| `muse-takeone doctor [--json]` | machine readiness: node, ffmpeg, Chromium renderer, disk, write perms |
| `muse-takeone reconstruct input.json -o demo.mp4` | validate → manifest → 1080p60 MP4 + contact sheet + QA report |
| `muse-takeone render <dir>` | re-render a kept work dir (`--keep-work-dir`) with different styling |
| `muse-takeone assemble ./frames` | Ken Burns-style video from stills, no cursor (upstream feature) |
| `muse-takeone setup` | download Chromium once, check ffmpeg (upstream feature) |

The original takeone workflow (rehearse live → export scenario → record) is fully intact for agents that drive their own browser. The reconstruction features above are the muse-takeone additions; upstream functionality is documented in [`skills/muse-takeone/references/scenario-api.md`](skills/muse-takeone/references/scenario-api.md).

## How it works

`reconstruct` copies the screenshots into a working dir (applying redactions), writes a `manifest.json` with `mode: "reconstructed"`, and synthesizes the 60 Hz cursor/click/key event stream plus camera shots from the action script. The compositor then renders the video from that manifest, split across browser workers that each encode a segment with ffmpeg. Cursor path and camera moves are computed from the log, not from the capture, so they stay smooth even when the page stutters. Output is H.264 MP4 by default, or VP9 WebM.

The render is deterministic: the same input always produces the same video. Crossfades are measured in output time and every frame names its own images, so parallel workers can't disagree.

How it works in detail: [`docs/architecture.md`](docs/architecture.md). Privacy and security notes: [`docs/privacy.md`](docs/privacy.md). Known limitations: [`docs/limitations.md`](docs/limitations.md).

## Development

```bash
npm test          # 42 unit tests (node:test + tsx)
npm run typecheck
npm run build
npm run visual-qa # render fixtures, diff contact sheets vs baselines (manual gate)
```

Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md). Changelog: [`CHANGELOG.md`](CHANGELOG.md).

## Attribution

muse-takeone is based on [takeone](https://github.com/atharvadeosthale/takeone) by Atharva Deosthale, MIT licensed. The reconstruction pipeline, CLI additions (`reconstruct`, `validate`, `inspect`), provenance model, redaction, and this documentation are the muse-takeone additions. No upstream endorsement is implied.

## License

MIT — see [LICENSE](LICENSE).
