# Examples

Runnable reconstruction traces. Every example's frames are synthetic placeholders — swap in your own screenshots and adjust the coordinates.

```bash
tracereel validate examples/muse/github-tour/trace.json
tracereel inspect examples/muse/github-tour/trace.json
tracereel reconstruct examples/muse/github-tour/trace.json -o tour-demo.mp4
```

| example | shows |
|---|---|
| [muse/github-tour](muse/github-tour/) | the reference Muse trace: states + actions, agent-browser/muse provenance |
| [generic/form-submit](generic/form-submit/) | click → type into fields, visible vs sensitive typing, one shot for the whole flow |
| [generic/scroll-tour](generic/scroll-tour/) | scroll actions, automatic slide transitions between page states |
| [generic/dashboard-tour](generic/dashboard-tour/) | sidebar → content navigation with a camera reframe between distant targets |
| [grokbot](grokbot/) | planned integration: the target trace contract (no frames yet) |

Each example's README walks through the input part by part. The full field reference is [`docs/TRACE_FORMAT.md`](../docs/TRACE_FORMAT.md) and `schema/reconstruction.schema.json`.
