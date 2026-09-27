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

`screenshots`, `clickCoordinates`, `typingCoordinates`, `scrollEvents`, `hoverEvents`, `videoSegments`, `cursorFreeScreenshots`.

Every flag defaults sensibly per adapter (`tracereel capabilities <agent>` shows them); a trace may override them. Unknown agents get the conservative set.

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
