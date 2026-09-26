# Changelog

All notable changes to muse-takeone. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.1.0] — 2026-09-27

First release. muse-takeone is based on [takeone](https://github.com/atharvadeosthale/takeone)
by Atharva Deosthale (MIT); everything below the line is new in the fork.

### Added — reconstruction workflow

- `muse-takeone reconstruct input.json`: screenshots + action script →
  recording manifest → 1080p60 MP4 through the real compositor.
- Action model: `click` (eased glides, ripples, `preClickMs`/`clickHoldMs`/
  `pauseMs`/`nextFrameAfterMs`), `type` (per-character keys, key HUD pill,
  `showKeys`, `sensitive`), `scroll` (auto slide transition into the next
  frame), `hover` (camera focus, never clicks), `wait` (explicit beat).
- Action → UI-state timing: the next screenshot cuts in ~200 ms after the
  last action event by default (`nextFrameAfterMs` overrides).
- Camera planned in settled shots (`src/reconstruct/shots.ts`): nearby
  interactions share one framing, cuts never move the camera, reframes are
  direct, the final shot releases to the overview. Explicit `shots` override
  supported.
- Per-frame `transitionIn`: `crossfade` (default 140 ms, output-time),
  `cut`, `{ kind: "slide", dx, dy }` (scroll cuts auto-slide).
- `source` provenance metadata (`muse-managed-browser` | `external-browser` |
  `manual-screenshots`), preserved verbatim; `--require-source` fails loudly
  on mismatch. Declarative, not cryptographic.
- Input validation (`muse-takeone validate`) with exact frame/action error
  locations, plus `schema/reconstruction.schema.json` (version 1).
- `muse-takeone inspect`: source, frames, action counts, expected duration,
  planned camera shots, output settings, QA warnings.
- `muse-takeone doctor`: node / ffmpeg / Chromium renderer / disk / write
  checks, with `--json`.
- QA report after every render: duration, resolution, fps, clicks, typed
  chars, scrolls, hovers, waits, shots, transitions, captions, event count —
  plus warnings (aggressive zoom, rapid reversal, mid-reframe clicks,
  lingering frames).
- Redaction at frame-copy time: `blur` / `solid` / `pixelate` regions via
  ffmpeg, global or per-frame.
- Deterministic builds: same input + same workers = byte-identical video.

### Added — tests, docs, CI

- 27 new unit tests (cases H–V): typing model, timing, scroll/hover/wait,
  validation, redaction execution, schema round-trip, determinism, unicode,
  QA, provenance, transitions, `--require-source`.
- Visual regression fixtures (`tests/fixtures/visual/`: form, scroll, nav)
  with DOM-grounded targets and committed contact-sheet baselines;
  `npm run visual-qa` renders and diffs them (manual gate, not CI).
- Docs: `docs/architecture.md`, `docs/privacy.md`, `docs/limitations.md`,
  `CONTRIBUTING.md`, this changelog, `examples/` with annotated inputs.
- Rewritten `skills/muse-takeone/SKILL.md` (repo-direct install, managed-browser
  capture rules, honesty requirements).
- GitHub Actions CI: `npm ci` + typecheck + tests + build on Node 20/22.

### Changed

- Package identity: `muse-takeone` 0.1.0, primary `muse-takeone` binary with
  `takeone` alias, repository URLs point at this fork.
- The bundled `doctor` command now covers the full render environment
  (previously Chromium + ffmpeg only) with `--json` output.

### Fixed

- Compositor blend: the outgoing image is now kept for the whole blend window
  (previously only the first frame after a cut carried it, so crossfades never
  played).
- Camera keyframes are mapped to output time (previously desynced under
  time-lapse).
