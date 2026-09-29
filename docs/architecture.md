# Architecture

How TraceReel turns an AI-agent browser trace and a folder of screenshots into a
1080p60 MP4. The native takeone path (drive a live browser, record the event log)
shares the compositor; everything under `src/reconstruct/` plus the adapter
layer (`src/adapters/`, `src/trace/`, `src/bundle.ts`, `src/capabilities.ts`,
`src/sdk.ts`) is the TraceReel addition.

> Agent neutrality: adapters normalize each agent's trace into Trace Format v1
> (`docs/TRACE_FORMAT.md`) before anything below runs. The renderer never sees
> agent identity — adding an agent means writing an adapter, not touching the
> pipeline described here.

## Pipeline

```
input.json (+ frames/)
  │  validateReconstructionInput      src/reconstruct/validate.ts
  ▼
buildReconstructionManifest           src/reconstruct/build.ts
  │  action script → 60 Hz event stream (mouse/key/scroll/hover markers)
  │  + per-frame timing (holdMs, nextFrameAfterMs)
  ▼
writeReconstructionDir                src/reconstruct/build.ts
  │  copy frames (applyRedactions via ffmpeg) → workDir/frames/
  │  write manifest.json (mode: "reconstructed")
  ▼
planReconstructionCamera              src/reconstruct/shots.ts
  │  focus events → grouped shots → camera keyframes
  ▼
renderRecording                       src/compositor/render.ts
  │  planFrameInstructions (per-frame images, transitions, captions, HUD)
  │  N Chromium workers render segments → ffmpeg x264 → MP4
  ▼
contact sheet + QA report             src/reconstruct/qa.ts
```

`tracereel reconstruct` runs the whole chain. `tracereel render <workDir>`
re-runs only the render stage (restyle a take without rebuilding the manifest).

## The manifest

`RecordingManifest` (`src/types.ts`) is the single contract between capture and
render:

- `mode: "reconstructed"` marks manifests built from an action script. The render
  path branches on it (`planCameraKeys`, `makeCamAtOut` in `src/compositor/render.ts`).
  Inputs containing at least one dense real-frame run build with
  `mode: "native"` — the TakeOne click-driven auto-zoom camera path — because
  every page pixel is already real.
- `visualSource` (`"managed-real-frames"` | `"reconstructed-sparse"` | `"mixed"`)
  records which visual path the frames selected. The CLI prints it after
  reconstructing.
- `frames[]`: one entry per screenshot — file, source-time `t`, `transitionIn`,
  caption range. Each frame names its **own** `previousFile`: workers are
  stateless and never depend on a sibling's output.
- `events[]`: the synthetic interaction log — `mouse` samples (60 Hz eased glides),
  `mousedown`/`mouseup`, `key` (one per typed character, `source: "type"`),
  `scroll`/`hover` markers. Sorted by `t`; the compositor never invents motion.
- `source`: provenance metadata, preserved verbatim. Declarative, not
  cryptographic — see `docs/limitations.md`.

## Managed real-frame path — the primary visual path (`src/reconstruct/realframes.ts`)

`buildReconstructionManifest` detects dense runs up front (`detectDenseRuns`:
two or more consecutive states with `capture.dense`). A dense run emits one
manifest frame per capture with back-to-back `cut` transitions — never a
`slide` — and consumes its enclosing scroll/type/click/hover action:

- **scroll run**: no `scroll` event is emitted and scrollplan is never invoked.
  The real frames *are* the motion. Duration is the action's `durationMs`
  (default 600), or the true capture spacing when every capture carries a
  non-decreasing `capture.t` (`denseRunFrameTimes`).
- **type run**: one `key` event per character, timed at the capture each
  character produced — drives the key HUD.
- **click run**: `mousedown`/`mouseup` at the click point — drives ripples and
  the auto-camera. **hover run**: a `hover` event at the hover point.

Cursor positioning glides and actions attached to later run frames still play
(before/after the run, respectively); nothing interleaves *inside* a run.
States outside dense runs use the unchanged fallback reconstruction below, so
existing Trace v1 inputs render exactly as before.

## Event synthesis (`src/reconstruct/build.ts`)

Each action becomes timestamped events on one timeline:

- **click**: glide from the current cursor position along a curved path (cosine
  ease + perpendicular bow + deterministic jitter), `preClickMs` settle,
  `mousedown`/`clickHoldMs`/`mouseup`, ripple marker, `pauseMs`. `nextFrameAfterMs`
  (default 200 ms) sets the cut to the next frame's screenshot — the rhythm is
  *action → UI settles → state appears*, never action and state at once.
- **type**: one `key` event per Unicode code point with human-ish per-character
  gaps (deterministic jitter from a seeded PRNG — same input, same output).
  Special keys (`Enter`, `Backspace`, …) render as key-cap pills; printable runs
  merge into a growing text pill (`planKeyToasts`, `src/compositor/plan.ts`).
  `showKeys: false` or `sensitive: true` (default) suppresses the pill.
- **scroll**: a `scroll` marker with `dx`/`dy`. The *following* frame auto-selects
  `transitionIn: { kind: "slide", … }` in the scroll direction unless the author
  set a transition explicitly.
- **hover**: cursor glides, rests ~1.6 s, emits a `hover` marker. Never clicks.
- **wait**: pure timeline advance, no events — an explicit viewer beat.

Frame timing: a frame lasts `max(holdMs, actions duration)`; actions never get
clipped by a short hold, and a long hold is just a still beat. `holdMs` is a
floor, not a storytelling pause — use `wait` for those.

## Shot planning (`src/reconstruct/shots.ts`)

Philosophy: **SHOT = CAMERA MOVE**. The camera is planned from what the viewer
needs to see, not from raw clicks.

1. `extractFocusEvents`: clicks (mousedown), typing bursts (first character only —
   a burst is one focus), and hovers become focus events.
2. `groupFocusEvents`: two foci share a shot when they occur within `groupGap`
   (3 s) **and** one routine-scale framing covers both — tested as a bounding box
   fit, so click-into-field then typing 400 px away share a shot, while a
   sidebar → content jump does not.
3. `planShots`: each group becomes a shot — move in (`transitionMs` + `settleMs`
   before the first focus), hold through the last focus + `releaseMs`. A shot's
   framing fits its points' bbox at `routineScale` (1.35×), clamped to the
   viewport. Consecutive shots reframe directly (no zoom-out/in); the final shot
   releases to the full overview after a real gap.
4. `shotsToKeyframes` → `optimizeCameraKeys`: merges redundant keys, drops
   micro-moves; `auditCameraPlan` flags aggressive zoom and reversals.
5. `manifest.shots` (explicit) overrides planning entirely — the escape hatch.

The render maps camera keys to output time through the kept-range timeline
(`makeCamAtOut`); transition progress is likewise output-time, so time-lapse or
trimmed renders stay in sync.

## Transitions (`src/compositor/instructions.ts`)

Each frame instruction carries its own `previousFile` plus a `mix` window
(start/duration in output time). Types: `crossfade` (default 140 ms),
`cut`, `slide` (the outgoing screenshot translates while fading — used for
scroll cuts). Because every frame names its own images and blends are computed
in output time, parallel workers render identical pixels.

## Typing HUD and ripples (`src/compositor/plan.ts`)

- `planKeyToasts`: printable runs become one growing text pill anchored near the
  target; special keys become individual key-cap pills. All toasts are
  source-time ranges, so the pill grows as the characters land.
- Click ripples are expanding rings at the `mousedown` point, timed to the
  `mouseup`. Hover markers render as a soft ring, never a ripple.

## Redaction (`src/reconstruct/redact.ts`)

Runs at frame-copy time in `writeReconstructionDir`, before anything else sees
the pixels. Each region becomes an ffmpeg filter stage on a copy of the
screenshot: `blur` (crop → boxblur → overlay), `solid` (drawbox), `pixelate`
(crop → downscale → upscale → overlay). Regions are clipped to the viewport;
empty regions are skipped. Best-effort privacy helper, not a guarantee — see
`docs/privacy.md`.

## Validation (`src/reconstruct/validate.ts`)

Two layers: the JSON Schema (`schema/reconstruction.schema.json`, version 1 —
bumped only on breaking changes) for shape, and `validateReconstructionInput`
for semantics: file existence, coordinate bounds, duplicate basenames, timing
sanity, provenance values, redaction regions, and authoring smells (a final
action with no post-action screenshot, `nextFrameAfterMs` on a non-final
action, `sensitive` + `showKeys`). Errors name the exact frame/action and how
to fix it. `reconstruct` validates before rendering.

## QA (`src/reconstruct/qa.ts`)

`qaReconstruction` replays the input + manifest and reports metrics (duration,
resolution, fps, screenshots, clicks, typed chars, scrolls, hovers, waits,
camera shots, transitions, captions, event count) and warnings: zoom beyond
1.6×, camera reversing within 900 ms, clicks landing mid-reframe, frames
lingering >2 s after their last action. The CLI prints the metrics and
warnings after every render.

## Determinism

Same input + same workers = byte-identical video (modulo x264 thread noise with
different worker counts). Sources of randomness are seeded; jitter, glide
curves, and toast layout derive from the input. The visual fixtures
(`tests/fixtures/visual/`) pin this: `npm run visual-qa` re-renders them and
diffs contact sheets against committed baselines.

## Rendering (`src/compositor/`)

- `render.ts`: orchestrates workers, ffmpeg encode, contact sheet.
- `page.ts`: the Chromium page that draws one frame (background, screenshot,
  camera transform, cursor, ripples, HUD, captions).
- `plan.ts`: timeline, camera evaluation, cursor interpolation, key toasts.
- `instructions.ts`: per-frame render instructions (images, mix windows).

Headless Chromium is the renderer (set `TAKEONE_CHROMIUM_PATH` to skip the
Playwright download). It draws **already-captured** screenshots; in the
reconstruction path it never browses the target site.
