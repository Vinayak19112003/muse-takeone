# Limitations

Honest boundaries of what tracereel v0.1.0 can and cannot do.

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
visual change. The cut between them is reconstructed as a true scroll: both
screenshots translate with ease-in-out over the scroll's own `durationMs`, so
overlapping page content stays aligned and reads as one continuous page moving.
There is no continuous scrolling footage — if the screenshots are far apart or
the page repainted between captures, intermediate content is not invented. For
very long scrolls, capture more intermediate states.

### Sticky / fixed elements during scrolls

Scroll reconstruction translates the whole frame. Pages with sticky or fixed
elements (e.g. a pinned site header) will show that element sliding with the
page during the scroll transition instead of staying pinned — briefly, it may
appear twice (once on each screenshot) mid-transition. Detecting stationary
regions automatically requires pixel-level screenshot analysis with tolerance
for translucent or dynamic headers; that is not implemented. If a pinned
header dominates the visual, prefer smaller scroll steps between captures so
the artifact is brief.

## Web content only

The compositor renders web screenshots. Native apps, video playback, and WebGL
scenes render as whatever the screenshot shows — a still. Pages that repaint
faster than the render samples may look frozen; cursor and camera are
unaffected.

## No audio

The output is silent MP4/WebM. Narration, music, and sound effects are outside
the tool — mux them in with ffmpeg afterwards.

## Performance

Render cost scales with output pixels × fps × duration and worker count. The
compositor needs headless Chromium and ffmpeg on the machine (`tracereel
doctor` checks). Very long inputs (10+ minutes) are untested — prefer several
short takes.

## Platform

Developed and tested on Linux (Node 20+). macOS/Windows should work (Node +
Chromium + ffmpeg are portable) but are not verified for v0.1.0.
