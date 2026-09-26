# Examples

Three runnable reconstruction inputs. Each example's frames are synthetic
placeholders — swap in your own screenshots and adjust the coordinates.

```bash
muse-takeone validate examples/form-typing/input.json
muse-takeone inspect examples/form-typing/input.json
muse-takeone reconstruct examples/form-typing/input.json -o form-demo.mp4
```

| example | shows |
|---|---|
| [form-typing](form-typing/) | click → type into fields, visible vs sensitive typing, one shot for the whole flow |
| [scroll-tour](scroll-tour/) | scroll actions, automatic slide transitions between page states |
| [dashboard-nav](dashboard-nav/) | sidebar → content navigation with a camera reframe between distant targets |

Each example's README walks through the input part by part. The full field
reference is `schema/reconstruction.schema.json`.
