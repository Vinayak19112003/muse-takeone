# TraceReel audio: agent-generated narration + music

TraceReel turns an agent's browser trace into a polished demo video. The audio
side follows one fixed division of labor:

- **The agent** understands the browser workflow, decides what gets narrated,
  writes natural narration, renders it with its **own** TTS/voice capability,
  and optionally supplies background music.
- **TraceReel** handles scene timing, audio placement, duration validation,
  voice/music mixing, fades, optional music ducking, loudness/clipping
  protection, subtitle timing metadata, AAC output, the final FFmpeg mux
  (video stream copied with `-c:v copy`, never re-encoded), and audio QA.

**TraceReel does not generate voice. TraceReel does not generate music.**
There is no built-in TTS engine — no Chatterbox, Kokoro, ElevenLabs, OpenAI
TTS, or anything similar in core. The agent brings finished audio files;
TraceReel mixes them. This keeps the architecture agent-neutral: Muse's TTS,
a Grokbot voice tool, another agent's pipeline, or a human recording all work
the same way.

## The workflow

This is the proven pattern, now structured and repeatable:

```
silent reconstructed video (tracereel reconstruct)
  +
agent-written narration, rendered by the agent's own TTS -> one audio file per scene
  +
optional background music supplied by the agent
  ↓
tracereel audio video.mp4 --trace trace.json -o final.mp4
  ↓
scene-timed placement, mixing, ducking, fades, AAC
  ↓
final MP4 (video stream copied, not re-encoded)
```

End to end for an agent:

1. Perform the browser task in the browser the agent actually drives.
2. Capture states/actions (screenshots + coordinates).
3. Write the TraceReel trace.
4. Decide which scenes need narration.
5. Write concise, natural narration per scene.
6. If the agent has a TTS/voice tool, generate one voice clip per narrated scene.
7. Save clips under `audio/narration/`.
8. Associate each clip with its state id in `trace.json` (`narration[]`).
9. Optionally supply music (`audio.music`).
10. `tracereel validate trace.json` — fix every error.
11. `tracereel inspect trace.json` — check the audio section.
12. `tracereel reconstruct trace.json -o silent.mp4` — render visuals.
13. `tracereel audio silent.mp4 --trace trace.json -o final.mp4` — mix + mux.
14. Read the QA output; repair issues if needed.
15. Ship `final.mp4`.

## Trace format

```json
{
  "narration": [
    {
      "state": "intro",
      "text": "Meet Groom Room, a simple booking experience for pet grooming.",
      "audio": "audio/narration/intro.mp3",
      "generatedBy": { "agent": "muse", "tool": "tts", "provider": "meta-ai" }
    },
    {
      "state": "booking",
      "text": "Now choose the grooming service and available time.",
      "audio": "audio/narration/booking.mp3"
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

### Narration clips

- `state` — a state id (states-form traces) or a 0-based frame index as a
  string (frames-form traces). The clip starts when that scene starts on the
  **final output timeline** — the agent never computes timestamps.
- `audio` — the finished voice file, relative to the trace file (or the
  bundle's `audio/` dir). MP3, WAV, and M4A/AAC are the tested inputs;
  anything ffprobe can decode is accepted.
- `text` — the spoken words. Used for subtitle cues when present; clips
  without text simply get no subtitle cue.
- `startMs` — advanced override: an explicit output-timeline start in ms.
  Omit it for normal state-based placement.
- `generatedBy` — informational provenance (`agent`, `tool`, `provider`,
  `voice`, `language`, `speed`). Every field is optional. **Never invent
  provider, voice, or tool details — omit what the agent does not know.**

### Music

- `file` — agent-supplied music (royalty-free, self-generated, whatever the
  agent provides). TraceReel never generates music.
- `volume` — linear gain 0..1 (default `0.10`).
- `loop` — loop/trim to the final video duration (default `true`).
- `fadeInMs` / `fadeOutMs` — fades in ms (default `0`).
- `duckUnderNarration` — lower the music while narration plays, restore it
  smoothly after (default `false`, for predictable behavior). Implemented with
  FFmpeg sidechain compression keyed off the narration bus.

## Timing model

Video timing is fixed first; narration fits into it. TraceReel resolves each
clip's state to the scene's start on the output timeline (from the
reconstruction manifest — final output time, not raw capture timestamps).

Scenes are **not** stretched to fit speech in this version. If a clip is
longer than its scene, planning emits a structured warning:

```json
{
  "code": "NARRATION_EXCEEDS_SCENE",
  "state": "booking",
  "sceneDurationMs": 6000,
  "audioDurationMs": 8100,
  "suggestion": "Shorten the narration or adjust the scene timing."
}
```

Narration that would run past the end of the video is trimmed to the video
duration (warning issued).

## FFmpeg strategy

One FFmpeg invocation per `tracereel audio` run:

```
ffmpeg -i video.mp4 -i narr1.mp3 ... -i music.m4a \
  -filter_complex "<graph>" \
  -map 0:v -map "[aout]" \
  -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -movflags +faststart out.mp4
```

- `-c:v copy` — the video stream is copied, never re-encoded. After the mux,
  TraceReel compares per-frame hashes of input and output video and refuses to
  ship the file if any frame changed.
- Narration clips are delayed to their scene starts, summed, and padded to the
  full duration (the padding matters: the ducking sidechain must span the
  whole timeline or the music gets truncated when narration ends early).
- Music is looped/trimmed to the video duration, gained, and faded.
- Ducking (optional): `[music][narration] sidechaincompress` — threshold 0.02,
  ratio 8, attack 200ms, release 600ms. Deterministic for fixed inputs.
- Final chain: `alimiter=limit=0.95` (clipping protection), exact-duration
  trim/pad, 48kHz stereo, AAC-LC 192k.

The code is split the way the pipeline is: `src/audio/probe.ts` (ffprobe
inspection), `plan.ts` (state→time resolution, validation), `mix.ts`
(filter-graph construction), `mux.ts` (the `-c:v copy` mux + frame-hash
proof), `qa.ts` (audio QA), `subtitles.ts` (srt/vtt export).

## Validation

`tracereel validate trace.json` checks audio when the trace declares it:

| Code | Meaning | Severity |
|---|---|---|
| `AUDIO_FILE_MISSING` | declared audio file does not exist | error |
| `AUDIO_PATH_OUTSIDE_BUNDLE` | path escapes the trace/bundle directory | error |
| `AUDIO_UNDECODABLE` | ffprobe cannot decode the file | error |
| `AUDIO_ZERO_DURATION` | file has no duration | error |
| `NARRATION_MISSING_STATE` / `NARRATION_UNKNOWN_STATE` | bad state reference | error |
| `NARRATION_MISSING_AUDIO` | clip has no audio file | error |
| `NARRATION_NEGATIVE_START` | `startMs` < 0 | error |
| `MUSIC_MISSING_FILE` | music block has no file | error |
| `MUSIC_INVALID_VOLUME` | volume outside 0..1 | error |
| `MUSIC_INVALID_FADE` | negative fade, or fades longer than the video | error |
| `NARRATION_EXCEEDS_SCENE` | clip longer than its scene | warning |
| `NARRATION_PAST_VIDEO_END` | clip runs past the video end (trimmed) | warning |
| `NARRATION_OVERLAP` | two clips overlap and will play together | warning |
| `MUSIC_ENDS_EARLY` | `loop: false` and the track is shorter than the video | warning |
| `AUDIO_CODEC_UNUSUAL` | decodable but not MP3/WAV/AAC-family | warning |

## Inspect

`tracereel inspect trace.json` gains an audio section (text and `--json`):

```
audio:
  narration clips: 3
  narration total duration: 6.0s
  music:
    audio/music/background.m4a
    loop: yes
    volume: 10%
    ducking: enabled
  final audio: AAC, 48kHz, stereo
```

## QA

Audio QA reports verifiable facts only — no subjective quality scores:

- narration clip count, onset times, total duration, overflow count
- music present, loop state, volume, ducking on/off
- final codec / sample rate / channels / duration
- silent-track detection (mean volume ≤ −60 dB warns)
- loudness: measured integrated LUFS and true peak (dBTP) of the final file,
  the target, and whether normalization ran; warns when the measured program
  misses the target by more than 1 LU or breaches the true-peak ceiling

## Loudness normalization

After mixing and ducking, the finished program is mastered to a consistent
loudness with FFmpeg's two-pass `loudnorm` (`linear=true`: a constant gain,
deterministic for fixed inputs — no dynamic range reshaping that could fight
the ducking). The true-peak limiter stays active, so normalization can never
introduce clipping.

Defaults: **−16 LUFS integrated, −1.5 dBTP maximum true peak.**

Configure it in the trace:

```json
"audio": {
  "loudness": { "targetLUFS": -16, "maxTruePeakDbTP": -1.5 }
}
```

Or disable it (`"loudness": { "disabled": true }`) to ship the mix as-is.
CLI overrides: `tracereel audio --loudness-target -14 --loudness-peak -1`,
`--no-loudness` to disable.

Normalization never touches scene timing, the ducking graph, or the video
stream (`-c:v copy` still holds; frame hashes are verified identical).

## Subtitles

`tracereel audio --subtitles srt|vtt|both` writes sidecar subtitle files from
narration cues: cue starts when the clip starts, ends when the clip ends, text
from the clip's `text`. This never replaces TraceReel's existing burned-in
captions; it is an optional extra for players with subtitle support.

## Bundles

Audio lives in the bundle, always local:

```
demo.tracereel/
├── trace.json
├── frames/
├── audio/
│   ├── narration/
│   └── music/
├── segments/
└── metadata.json
```

`tracereel bundle` copies narration clips to `audio/narration/` and music to
`audio/music/`, rewriting the trace paths. Nothing is ever uploaded.

## Privacy

All audio stays local — narration clips, music, and the mix never leave the
machine. `generatedBy` provenance is declarative metadata in the trace, not a
verified claim and not cryptographic proof.

## Browser audio

Not implemented. Screenshots cannot reconstruct browser/system sound, and
TraceReel will not synthesize or fake it. The capability flag
`browserAudio` exists and stays `false` until an agent genuinely captures
browser audio and supplies it. The architecture accepts it the same way it
accepts narration: a real file, placed on the timeline.

## Known limitations

- Video-first timing only: scenes never stretch to fit narration (a future
  version may support narration-driven timing).
- Ducking uses fixed sidechain parameters; no per-clip duck amounts yet.
- No loudness normalization across clips — the agent masters its clips;
  TraceReel only guards against clipping.
- Subtitle cues are clip-level (no word timings).
- `browserAudio` is reserved, not implemented.
