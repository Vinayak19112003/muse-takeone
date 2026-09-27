# scroll-tour

Scrolling through a long page in three captured states, with the video sliding
down between them.

```bash
tracereel reconstruct examples/scroll-tour/input.json -o scroll-demo.mp4
```

## What the input does

**Frames 1–2** each carry a single `scroll` action: `dy: 700` moves the page
down 700 px over `durationMs: 700`, with the cursor resting where it was (the
action has no x/y, so no glide happens).

**The slide is automatic.** The frame *after* a scroll action — when its own
`transitionIn` is unset — gets `{ kind: "slide" }` in the scroll direction.
The outgoing screenshot slides away while fading, which reads as continuous
scrolling through stills. Set `transitionIn` explicitly (e.g. `"cut"`) if you
ever want the plain jump instead.

**Frame 3** is the bottom state with `holdMs: 2200` — the end of the tour.

## The rule to remember

A scroll action never moves pixels by itself; it only marks the timeline. The
visual change lives in the screenshots — one settled state per frame. If you
want smooth scrolling through a long page, capture more intermediate states;
three cuts reads as a tour, eight cuts reads as scrolling.
