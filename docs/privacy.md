# Privacy and security

muse-takeone exists to make videos of real browser sessions — often signed-in
ones. Treat every input as sensitive until proven otherwise.

## What the tool sees

- **Screenshots** of the managed browser: names, avatars, messages, account
  numbers, tokens, addresses — whatever was on screen. The frames directory is
  the most sensitive artifact in the pipeline. Keep it local; never commit it;
  delete it when the video is done.
- **Action scripts** (`input.json`): coordinates and typed text. Fake
  credentials only — never put real usernames, passwords, API keys, or tokens
  in an input file, even with `sensitive: true`.
- **Working directories** (`.reconstruct/`): copied frames + `manifest.json`.
  Same sensitivity as the frames. `reconstruct` deletes the work dir by default;
  `--keep-work-dir` keeps it for restyling — delete it after.

## Redaction

`redactions` hide regions at frame-copy time with ffmpeg, before the compositor
or the output video ever sees the pixels:

```json
{
  "redactions": [
    { "x": 100, "y": 200, "width": 300, "height": 40, "mode": "blur" }
  ]
}
```

Modes: `blur` (heavy), `solid` (opaque black), `pixelate` (mosaic). Redactions
can be global (top-level) or per-frame. Regions are clipped to the viewport.

**This is a best-effort helper, not a guarantee.** It only hides what the
regions cover: a tooltip that appears mid-video, an autocomplete dropdown, a
notification banner, or text visible *around* the region all leak through. After
rendering, scrub the video (or the contact sheet, which `reconstruct` writes
next to the output) frame by frame before publishing. If a take shows something
it shouldn't, widen the regions and re-render — never ship hoping nobody
pauses.

## Sensitive typing

`{ "kind": "type", "sensitive": true }` hides the on-screen key pill so the
video never shows what was typed. The `text` still lives in `input.json` and
the manifest — which is why the rule above stands: fake credentials only.

## Provenance is declarative

`source: { "type": "muse-managed-browser", … }` is metadata you assert. It
does not cryptographically prove a PNG's origin, and this documentation never
claims it does. Don't use it as evidence of authenticity beyond your own
workflow.

## Supply chain

- Install from this repository (`npm ci`); the lockfile pins every dependency.
- The renderer is headless Chromium (Playwright-bundled or
  `TAKEONE_CHROMIUM_PATH`) plus the ffmpeg binary resolved by `src/ffmpeg.ts`
  (system ffmpeg preferred, `ffmpeg-static` fallback). Both execute locally;
  nothing is uploaded.
- Rendering never makes network requests to the target site in the
  reconstruction path — it draws already-captured screenshots.

## Reporting

If you find a privacy or security issue in muse-takeone, open a GitHub issue
and mark it clearly; avoid posting screenshots containing real personal data.
