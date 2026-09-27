---
name: tracereel-adapter-muse
description: Capture a TraceReel trace from Muse's managed browser. Use when building a demo video from a workflow Muse performs in its own browser session. Covers the Muse adapter's provenance, capability defaults, and the v0.1.x legacy migration.
---

# TraceReel adapter: Muse

Muse is the tested reference integration. Its adapter (`src/adapters/muse.ts`, registered as `muse`) normalizes Muse's traces into Trace Format v1.

## Provenance

Muse traces declare:

```json
{ "version": 1, "source": { "type": "agent-browser", "agent": "muse", "session": "main" }, ... }
```

The legacy v0.1.x form `source.type: "muse-managed-browser"` is still accepted and normalizes to `agent-browser` / `muse` with a deprecation warning. `--require-source muse-managed-browser` keeps matching it, so existing Muse workflows don't break.

Capabilities for Muse traces (`tracereel capabilities muse`): screenshots, click/type coordinates, scroll and hover events — all verified against real captures.

## Capture notes specific to Muse

- The capture source is the browser Muse is already driving — its managed session, logged-in state, cookies, theme. See the main `tracereel` skill for the hard capture rules; they were written for this browser.
- Emit states and actions (the preferred form), or hand the adapter the older frames-with-actions form — both normalize.
- Ground every click/type target from the screenshot of the state it acts on.
- One settled UI state per screenshot; capture before and after every UI-changing action.
- Paint the baked-in OS cursor out of each screenshot before rendering.
- Describe the output as "reconstructed from real screenshots", never a live recording.

## Importing a raw Muse log

If Muse's session log isn't Trace Format v1 yet, the adapter migrates it:

```bash
tracereel import muse-log.json --adapter muse -o demo.tracereel
tracereel validate demo.tracereel/trace.json --json
```

The bundle records the adapter name and normalization warnings in its metadata.
