# Grokbot (planned integration)

Grokbot is a planned TraceReel integration, not a verified one. The grokbot adapter exists (`src/adapters/grokbot.ts`) so the pipeline shape is fixed, but no Grokbot traces have been tested end to end yet — treat everything below as the target contract.

## What a Grokbot trace will look like

A Grokbot capture tool should emit Trace Format v1 directly:

```json
{
  "version": 1,
  "source": { "type": "agent-browser", "agent": "grokbot", "session": "demo-1" },
  "viewport": { "width": 1280, "height": 800 },
  "states": [
    { "id": "home", "screenshot": "01-home.png", "caption": "Grokbot opens the dashboard." },
    { "id": "done", "screenshot": "02-done.png", "caption": "Task complete." }
  ],
  "actions": [
    { "kind": "click", "from": "home", "to": "done", "x": 640, "y": 400, "stateDelayMs": 900 }
  ]
}
```

Then:

```bash
tracereel import grokbot-output.json --adapter grokbot -o demo.tracereel
tracereel validate demo.tracereel/trace.json --json
tracereel reconstruct demo.tracereel/trace.json -o demo.mp4
```

`tracereel capabilities grokbot` shows the expected capability set (marked planned, not verified).

## If you are building the Grokbot capture side

- Emit one settled screenshot per UI state, named by state.
- Emit actions with `from`/`to` state ids and coordinates in the trace viewport.
- Declare anything Grokbot cannot express in `capabilities` — the validator warns instead of guessing.
- Keep `source.agent` as `"grokbot"`; the renderer never branches on it, so no TraceReel release is needed to support new Grokbot trace shapes beyond the adapter.
