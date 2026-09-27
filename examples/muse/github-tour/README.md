# github-tour (Muse)

The reference Muse trace: states and actions in Trace Format v1, normalized through the Muse adapter.

```bash
tracereel validate examples/muse/github-tour/trace.json --json
tracereel inspect examples/muse/github-tour/trace.json --json
tracereel reconstruct examples/muse/github-tour/trace.json -o tour-demo.mp4
```

The trace is two states — `repo` and `merged` — connected by one click action. The Muse adapter verifies the `agent-browser` / `muse` provenance and fills Muse's capability defaults.

**About the frames:** they are synthetic placeholders so this example runs anywhere. For a real demo, capture the screenshots from Muse's managed browser (real logged-in state) and keep everything else the same. The trace's `source.note` says exactly that.
