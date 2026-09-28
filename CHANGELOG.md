# Changelog

All notable changes to TraceReel (formerly muse-takeone). Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.3.1] — 2026-09-28

### Fixed — smooth scroll reconstruction

- Reconstructed scrolls now animate continuously over their declared
  duration instead of rendering as slideshow-like page changes: a moving
  document layer plus a newly revealed strip, composited per frame.
- Overlapping page content no longer renders as two full screenshots —
  overlap-aware strip compositing keeps text continuous through the scroll.
- Fixed and sticky regions are handled separately from the moving document
  (fixed crossfades in place; sticky moves with its own measured offset).
- The scrollbar stays viewport-fixed with an interpolated thumb while the
  document moves underneath it.
- Measured scroll displacement (deterministic coarse-to-fine normalized
  cross-correlation) can correct inaccurate declared offsets, with a
  deterministic fallback and QA warnings (`SCROLL_ALIGNMENT_LOW_CONFIDENCE`
  and friends) when measurement is unreliable.
- Correct pre-cut timing so `durationMs` maps to visible motion once, not twice.
- New scroll QA checks for discontinuities and alignment; scrollplan
  generation is fully deterministic (no per-frame analysis, no randomness).

**Compatibility:** no trace-format breaking changes; the v0.3.0 audio
workflow (`tracereel audio`) is unchanged; Node 20+ supported.

## [0.3.0] — 2026-09-28

### Added — native agent-audio pipeline

- `tracereel audio`: mix agent-supplied narration and background music onto
  a reconstructed video, producing a final narrated MP4.
- Agent-provided narration clips (top-level `narration[]`): per-clip file,
  scene/state-anchored start times, gain, fades. TraceReel places them on
  the timeline — it does not generate speech.
- State/scene synchronization: narration is anchored to trace states, so
  voice-over follows the visual timeline exactly.
- Background music (`audio.music`): looping bed with configurable level.
- Optional ducking: music dips under narration (sidechain-style volume
  automation in the mix graph).
- Subtitle export: SRT and VTT generated from narration clips.
- AAC output: 48 kHz stereo AAC; video stream is never re-encoded
  (`-c:v copy`), decoded frame hashes verified identical after muxing.
- Audio QA: integrated LUFS, true peak (dBTP), narration onsets, clipping
  check, normalization status — reported after every mix.
- Final loudness mastering: deterministic two-pass FFmpeg `loudnorm`
  (`linear=true`) after mixing and ducking. Default −16 LUFS integrated /
  −1.5 dBTP max true peak; configurable via trace `audio.loudness` or CLI
  `--loudness-target` / `--loudness-peak` / `--no-loudness`.
- True-peak protection: 0.5 dB codec headroom reserved in the filter target
  because AAC encoding overshoots PCM true peak; the final encoded file
  respects the configured ceiling.
- Docs: `docs/AUDIO.md`.

**No built-in TTS provider.** TraceReel has no text-to-speech. The agent
generates voice with its own TTS (Muse uses its own voice pipeline) and
supplies audio files; TraceReel receives the clips and produces the final
audio/video. Validated end-to-end with real Muse-generated narration:
−27.02 LUFS / −8.5 dBTP in → −16.34 LUFS / −1.92 dBTP out, onsets and
frames unchanged.

## [0.2.0] — 2026-09-27

TraceReel is the agent-neutral evolution of muse-takeone: any supported AI
browser agent's trace becomes a polished demo video. Muse is the
tested/reference adapter; Grokbot is planned.

### Added

- TraceReel Trace v1: preferred `states[]` + `actions[]` form (legacy
  `frames[]` still accepted); `source.type: "agent-browser"` with free-form
  `source.agent`.
- Adapter architecture: `MuseAdapter`, `GrokbotAdapter`, `GenericAdapter`.
  Unknown agent names fall through to the generic adapter — no renderer
  changes needed for future agents.
- Capability declarations per adapter (`tracereel capabilities`).
- Structured machine-readable errors (`TraceReelError`: code, path, message,
  suggestion).
- Portable `.tracereel` capture bundles + `tracereel import`.
- TypeScript `TraceBuilder` SDK.
- CLI renamed to `tracereel` (`takeone`, `muse-takeone` remain as deprecated
  aliases); `TRACEREEL_*` environment variables preferred (`TAKEONE_*` still
  honored as deprecated fallbacks).
- `docs/TRACE_FORMAT.md`; restructured examples (`examples/generic/`,
  `examples/muse/`, `examples/grokbot/`); skills under `skills/tracereel/`
  and `skills/adapters/muse/`.

### Changed

- QA warnings are categorized (`camera`, `timing`, `missing-state`,
  `viewport`, `other`); no global quality score is fabricated.
- Bundle layout separates screenshots (`frames/`) from future video-segment
  assets (`segments/`).

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

- 28 new unit tests (cases H–W): typing model, timing, scroll/hover/wait,
  validation (including path-traversal rejection), redaction execution, schema
  round-trip, determinism, unicode, QA, provenance, transitions,
  `--require-source`.
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
