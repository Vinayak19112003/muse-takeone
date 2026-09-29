# TraceReel Trace Format v1

A TraceReel trace describes what an AI agent did in a browser: which UI states it saw, and which actions moved it between them. The reconstruction engine turns that description into a polished video. This document is the format's contract; the TypeScript types live in `src/trace/types.ts`.

## Design principles

1. **States, not screenshots.** The trace is a state machine: named UI states connected by actions. Frames are just how states get rendered.
2. **Agent-neutral.** The trace names its agent in `source.agent`, but nothing downstream branches on it. A new agent means a new adapter, never renderer changes.
3. **Declarative provenance.** `source` says where the trace claims to come from. It is metadata, not cryptographic proof — TraceReel trusts the capturer and says so.
4. **Local and private.** A trace plus its screenshots directory is everything needed. Nothing is uploaded by the reconstruction pipeline.

## Top-level shape

```json
{
  "version": 1,
  "source": { "type": "agent-browser", "agent": "muse", "session": "main" },
  "viewport": { "width": 1919, "height": 992 },
  "screenshotsDir": "frames",
  "capabilities": { "screenshots": true, "clickCoordinates": true },
  "states": [ ... ],
  "actions": [ ... ]
}
```

| field | required | meaning |
|---|---|---|
| `version` | yes | Trace format version. Currently `1`. |
| `source` | yes | Provenance. `type` is `"agent-browser"` (new), `"muse-managed-browser"`, `"external-browser"`, or `"manual-screenshots"` (legacy, deprecated). For `"agent-browser"`, `agent` is required and is a free-form agent name (`"muse"`, `"grokbot"`, anything). |
| `viewport` | yes | Capture viewport in CSS pixels. All coordinates are in this space. |
| `screenshotsDir` | no | Directory holding the screenshots, relative to the trace file. Defaults to the trace file's directory. |
| `capabilities` | no | What the capturing agent could express (see below). Adapters fill defaults; explicit declarations win. |
| `states` | one of | The UI states. Required in the preferred form. |
| `actions` | no | Actions between states. Required with `states`. |
| `frames` | one of | Legacy form: frames with embedded actions. Converted to states internally. Never mix with `states`. |
| `videoSegments` | no | Reserved. Accepted and validated, but **not rendered** — the renderer works from screenshots only. |
| `motion`, `redactions`, `transitions` | no | Render tuning; same semantics as the legacy reconstruction input. |

## States

```json
{ "id": "home", "screenshot": "01-open.png", "caption": "Open the repo.", "holdMs": 2000 }
```

| field | required | meaning |
|---|---|---|
| `id` | yes | Unique state name within the trace. |
| `screenshot` | yes | Screenshot file, relative to `screenshotsDir`. One settled UI state per screenshot. |
| `caption` | no | Caption bar text shown while the state is up. |
| `holdMs` | no | How long the state rests before the next action's events begin. Default 1200. |

## Actions

Actions reference states by id. The common fields:

| field | meaning |
|---|---|
| `kind` | `"click"` \| `"type"` \| `"scroll"` \| `"hover"` \| `"wait"` |
| `from` | State id the action starts from. Required. |
| `to` | State id the action lands on. Optional — but a trace where every action has a `to` renders a complete story; a missing `to` after a UI-changing action warns. |
| `stateDelayMs` | Beat between the action's events finishing and the next state appearing. Default 600. |

Kind-specific fields:

- `click`: `x`, `y` (required). Optional `preClickMs`, `clickHoldMs`, `pauseMs`.
- `type`: `x`, `y`, `text` (required). Optional `cpm`, `showKeys`, `sensitive` (hides the key pill — use for anything credential-shaped, and prefer fake credentials anyway).
- `scroll`: `dx`, `dy` (at least one required, non-zero). Optional `x`, `y` (where the gesture starts), `durationMs`.
- `hover`: `x`, `y` (required). Optional `dwellMs`.
- `wait`: `durationMs` (required). Optional `nextFrameAfterMs`.

All coordinates are CSS pixels in the trace's `viewport`. Targets outside the viewport are errors.

## Capabilities

`capabilities` declares what the capturing agent's traces can express, so tooling can warn instead of silently degrading:

`screenshots`, `clickCoordinates`, `typingCoordinates`, `scrollEvents`, `hoverEvents`, `videoSegments`, `cursorFreeScreenshots`, `denseRealFrames` (the agent can emit managed dense real-frame captures — see below), plus the audio flags `narrationAudioGeneration` (the agent can generate narration audio with its own TTS/voice tool — TraceReel itself never provides TTS) and `browserAudio` (genuine captured browser audio; stays false until an agent actually captures it).

Every flag defaults sensibly per adapter (`tracereel capabilities <agent>` shows them); a trace may override them. Unknown agents get the conservative set.

## Managed real-frame capture

A state may carry exact browser captures in `capture` instead of (or in addition to) a single settled screenshot. This is the **primary visual path**: when two or more consecutive states are marked dense, they form a *dense run* — one manifest frame per capture, played back with direct cuts. Every page pixel inside a dense run comes from a real captured screenshot; scrollplan, NCC displacement reconstruction, B-strip reconstruction, synthetic translation, sticky/fixed inference, scrollbar synthesis, and endpoint crossfades are never invoked for it. Synthetic cursor, cursor path, click ripples, camera, framing/shadow, and key HUD still apply.

```json
{ "id": "scroll-07", "screenshot": "scroll07.png",
  "capture": { "dense": true, "order": 7, "scrollX": 0, "scrollY": 649,
               "viewport": { "width": 1919, "height": 992 } } }
```

| field | required | meaning |
|---|---|---|
| `dense` | yes (to join a run) | `true` marks this capture as part of a dense real-frame interval. Two or more consecutive dense captures form a run; a lone dense frame renders as an ordinary frame (and warns). |
| `order` | yes | 0-based capture order within the trace; must increase along the timeline. |
| `t` | no | Capture timestamp in ms (any epoch — only deltas matter). When *every* capture in a run carries a non-decreasing `t`, playback honors the true capture spacing: frame *i* plays at `t[i] − t[0]`. When omitted, partial, or regressed, the run spreads the enclosing action's duration uniformly instead (and QA warns). |
| `scrollX` / `scrollY` | no | Actual page scroll position at capture, in CSS px. Used for QA (monotonicity, endpoint agreement with the action's declared `dy`). |
| `viewport` | no | Viewport the screenshot was captured at; must match the trace viewport. |
| `actionId` | no | Id of the action that produced this capture (e.g. `"scroll-1"`). TraceReel also infers the association from `from`/`to` state links. |
| `settled` | no | `true` when the page had settled at capture (paint complete, no loading spinners). |

The protocol is agent-neutral: any agent whose managed browser can capture per-frame screenshots and metadata can emit it. TraceReel never depends on adapter internals. The `muse` adapter is the first verified producer; declare `capabilities.denseRealFrames: true` when the agent can produce dense runs.

Dense-run rules:

- A dense run belongs to the first `scroll`/`type`/`click`/`hover` action on its first state (the *enclosing action*). An action authored as *pre-run state → final dense state* is canonicalized onto the run's first frame so a dense scroll never degrades into a sparse slide.
- The run's duration: for `scroll`, the action's `durationMs` (default 600); for `type`, per-character timing from `cpm`; otherwise the captures play back in realtime. Explicit `capture.t` stamps override the spacing (see above).
- On the primary path (any manifest containing dense runs, i.e. `mode: "native"`), the implicit default transition between two real captured states is **CUT** — never an automatic crossfade. An explicitly authored `transitionIn` is still honored; the reconstructed fallback keeps its existing transitions.
- A `scroll` action enclosing a dense run emits **no** scroll event — the real frames *are* the motion. `type` emits one key event per character (driving the key HUD), `click` emits mousedown/up (driving ripples), `hover` emits a hover event.
- Validation (fatal): every dense capture's file must exist and decode; dimensions must match; `order` must be chronological. Harmless duplicates (identical file or pixel-identical frames when the page legitimately did not move) are warnings, not errors.
- Planning helper: `planScrollCaptures({ from, to, durationMs, fps })` emits deterministic per-output-frame capture targets along a cubic-bezier `(0.4, 0, 0.2, 1)` ease — the recommended plan for agents capturing dense scrolls.

## Narration and music

Traces may carry agent-generated audio. TraceReel never generates voice or
music — the agent supplies finished files and TraceReel mixes them onto the
finished video with `tracereel audio` (video stream copied, never re-encoded).

```json
{
  "narration": [
    {
      "state": "intro",
      "text": "Meet Groom Room, a simple booking experience for pet grooming.",
      "audio": "audio/narration/intro.mp3",
      "generatedBy": { "agent": "muse", "tool": "tts", "provider": "meta-ai" }
    }
  ],
  "audio": {
    "music": {
      "file": "audio/music/background.m4a",
      "volume": 0.10,
      "loop": true,
      "fadeInMs": 800,
      "fadeOutMs": 1200,
      "duckUnderNarration": true
    }
  }
}
```

- `narration[].state` — state id (or 0-based frame index as a string for the
  frames form). The clip starts when the scene starts on the final output
  timeline; `startMs` is an advanced explicit override.
- `narration[].audio` — MP3/WAV/M4A file, relative to the trace (or bundle
  `audio/`). Paths escaping the trace directory are rejected.
- `narration[].text` — spoken text, used for subtitle cues when present.
- `narration[].generatedBy` — optional informational provenance (`agent`,
  `tool`, `provider`, `voice`, `language`, `speed`); never fabricated.
- `audio.music` — optional background music, looped/trimmed to the video,
  with volume, fades, and optional ducking under narration.

Video timing is fixed: over-long narration warns (`NARRATION_EXCEEDS_SCENE`)
instead of stretching scenes. Full reference: [`docs/AUDIO.md`](AUDIO.md).

## Legacy compatibility

- `source.type: "muse-managed-browser"` (the v0.1.x form) normalizes to `{ "type": "agent-browser", "agent": "muse" }` with a deprecation warning. It keeps working; `--require-source muse-managed-browser` keeps matching it.
- The `frames[]` form (frames with embedded `actions`) converts to states internally: each frame becomes a state, each frame's actions become state actions with `from` set to that frame's state id.
- `screenshotsDir` at top level is honored by both forms.

## Validation

`tracereel validate trace.json --json` returns structured issues:

```json
{
  "ok": false,
  "errors": [
    {
      "severity": "error",
      "code": "COORD_OUTSIDE_VIEWPORT",
      "path": "frames[0].actions[0].x",
      "message": "frames[0].actions[0].x = 2000 is outside the 1280px viewport width",
      "suggestion": "Ground the click target from its own screenshot."
    }
  ],
  "warnings": []
}
```

Error codes are stable and documented in `src/reconstruct/validate.ts` (search `code:`). Warnings never block rendering; errors do.

## Writing traces by hand or from an agent

Prefer the `TraceBuilder` SDK over hand-writing JSON:

```ts
import { TraceBuilder, getAdapter } from "tracereel";

const t = new TraceBuilder({ agent: "muse", viewport: { width: 1919, height: 992 } });
const home = t.state("home", "01-open.png", { caption: "Open the repo." });
const merged = t.state("merged", "02-merged.png");
t.click({ from: home, to: merged, x: 1520, y: 147, stateDelayMs: 900 });
t.redactEverywhere({ x: 0, y: 0, width: 300, height: 60, mode: "blur" });
const trace = t.build();
```

For an agent that emits its own raw log format, write an adapter instead of hand-converting: implement `TraceReelAdapter` (see `src/adapters/types.ts`), register it, and `tracereel import raw.json --adapter <name>` produces a portable `demo.tracereel/` bundle.
