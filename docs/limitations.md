# Limitations

Honest boundaries of what TraceReel can and cannot do.

## Reconstruction is not a recording

The output is **reconstructed from real screenshots**: real frames, rebuilt
cursor path, planned camera. It is not a captured live recording, and must
never be described as one. Motion between screenshots is synthesized — the
cursor glides, the camera moves, cuts crossfade — but nothing that happened
*between* two screenshots is real footage. Fast animations, hover states that
appear and vanish, and anything the screenshots don't show are simply absent.

## Provenance is declarative

`source.type: "muse-managed-browser"` records *your assertion* about where the
screenshots came from. It is metadata, not a cryptographic attestation: given
an arbitrary PNG, nothing in this tool can verify its origin. Don't present it
as proof.

## The baked-in cursor

Screenshots taken by the OS/browser usually contain the real cursor. The
reconstruction draws its own cursor, so an uncleaned frame shows **two
cursors**. You must locate and paint out the baked-in cursor per frame before
rendering (~44 px mask around the tip; tighter where UI sits under it). This
is currently manual — the tool does not remove cursors for you. Check text
near the cursor after removal; inpainting can clip glyphs.

## Typing renders over stills

`type` actions replay the cursor and a key HUD over a static screenshot. If the
field visibly fills in real life, your *next* screenshot must show the filled
field — the tool does not render text into the page. (For fixtures, the typed
state is baked into the HTML.)

## One UI state per screenshot

The model assumes each screenshot is one settled UI state and each action's
result appears in the *next* screenshot. Mid-animation captures bake the
animation into a still and make crossfades look like glitches. Popovers,
toasts, and transient banners that appear between captures won't be in the
video.

## Scroll is reconstructed, not recorded footage

A `scroll` action declares `dx`/`dy`/`durationMs`; the *screenshots* carry the
visual change. Before rendering, the compositor analyzes each scroll's
screenshot pair: it measures the true document displacement via template
matching (the declared `dy` is only a prior), partitions the frame into
document, sticky, and fixed regions, and detects the scrollbar gutter.

The scroll is then rendered as a moving document layer plus a fixed viewport
layer: the pre-scroll document translates by the measured offset, the
newly-revealed strip comes from the post-scroll screenshot, fixed regions
crossfade without translating, sticky regions move by their own measured
offset, and the scrollbar stays viewport-fixed with an interpolated thumb.
Low-confidence analysis falls back safely to pure document motion with a QA
warning. There is no continuous scrolling footage — if the screenshots are
far apart or the page repainted between captures, intermediate content is not
invented. For very long scrolls, capture more intermediate states.

**Dense real-frame captures supersede all of the above.** When a scroll (or
any action) is covered by a dense real-frame run, the captured screenshots
play back with direct cuts — no displacement measurement, no B-strip, no
sticky/fixed inference, no scrollbar synthesis. The only requirement is that
the agent actually captured enough frames; the recommended plan is
`planScrollCaptures` (cubic-bezier `(0.4, 0, 0.2, 1)`, ~1 capture per output
frame). Sparse scrolls keep the reconstructed behavior described here.

### Sticky / fixed elements during scrolls

Region classification is intentionally conservative. Repetitive page content
can confuse displacement matching, and complex translucent or dynamic fixed
UI (animated headers, video overlays) may not classify perfectly. Screenshots
with major DOM or layout changes between captures (not just scrolling) may
fall back or show brief artifacts. If a pinned header dominates the visual,
prefer smaller scroll steps between captures.

## Web content only

The compositor renders web screenshots. Native apps, video playback, and WebGL
scenes render as whatever the screenshot shows — a still. Pages that repaint
faster than the render samples may look frozen; cursor and camera are
unaffected.

## Managed real-frame capture

Dense runs are only as good as the captures. TraceReel validates what it can
and warns about the rest, but it cannot fix bad input:

- **Capture timing is the agent's job.** Without `capture.timelineMs` on every capture,
  a run spreads the enclosing action's duration uniformly — fine for steady
  eased scrolls, wrong for irregular ones. Partial or regressed stamps fall
  back to uniform with a QA warning; they are never fatal. `timelineMs` is
  intended playback time, not wall-clock: physical capture latency belongs in
  `capturedAt` and can never stretch the video.
- **Missing or undecodable capture files are fatal** — a dense run with a hole
  cannot play. Duplicates (same file, or pixel-identical frames when the page
  legitimately did not move) are warnings, never errors.
- **A lone dense frame is not a run.** Two or more consecutive dense captures
  are required; a single marked frame renders as an ordinary frame and warns,
  so the marker never silently does nothing.
- **Dense runs need their action.** A run whose first frame carries no
  scroll/type/click/hover action plays back in realtime with a QA warning —
  attach the action that produced the captures.
- **Provenance is declarative.** `capture.scrollY`, `settled`, and friends are
  agent-reported metadata. TraceReel cross-checks what it can (dimensions,
  monotonicity, endpoint agreement, blank-frame probes) but the screenshots
  themselves are trusted as captured.

## Audio

TraceReel supports native audio post-production: agent-supplied per-state
narration clips, optional background music, timing, mixing, ducking,
loudness mastering, subtitles, and final AAC muxing.

TraceReel does not include a TTS or music-generation engine. Agents or users
provide the finished narration/music files; TraceReel handles the production
pipeline. See AUDIO.md for full documentation.

## Performance

Render cost scales with output pixels × fps × duration and worker count. The
compositor needs headless Chromium and ffmpeg on the machine (`tracereel
doctor` checks). Very long inputs (10+ minutes) are untested — prefer several
short takes.

## Platform

Developed and tested on Linux (Node 20+). macOS/Windows should work (Node +
Chromium + ffmpeg are portable) but are less verified.
