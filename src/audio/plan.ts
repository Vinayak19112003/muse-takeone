/**
 * Audio planning: resolve narration clips onto the final output timeline,
 * validate everything agent-side, and describe the music timeline.
 *
 * Timing rule: the agent never computes timestamps. Each narration clip names
 * a state; TraceReel already knows when that state/scene starts on the FINAL
 * OUTPUT timeline (the reconstruction manifest's frame times — not raw
 * capture timestamps). `startMs` is an advanced explicit override.
 *
 * Video-first timing: the video timeline is fixed. Narration that overflows
 * its scene produces a structured NARRATION_EXCEEDS_SCENE warning; scenes are
 * never stretched to fit speech in this version.
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { RecordingManifest } from "../types.js";
import type { TraceReelTrace } from "../trace/types.js";
import { probeAudioFile } from "./probe.js";
import type {
  AudioIssue,
  AudioPlan,
  PlannedLoudness,
  PlannedMusic,
  PlannedNarrationClip,
} from "./types.js";
import { LOUDNESS_DEFAULTS, SUPPORTED_AUDIO_CODECS } from "./types.js";

export interface PlanAudioOptions {
  /** Directory trace-relative audio paths resolve against. */
  baseDir: string;
  /**
   * CLI overrides for loudness normalization; trace values win unless the
   * override is set. `disabled: true` turns normalization off entirely.
   */
  loudnessOverride?: {
    targetLUFS?: number;
    maxTruePeakDbTP?: number;
    disabled?: boolean;
  };
}

/** Resolve a trace-relative audio path, rejecting anything outside baseDir. */
export function resolveAudioPath(baseDir: string, rel: string): string {
  const base = resolve(baseDir);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`audio path escapes the trace directory: ${rel}`);
  }
  return abs;
}

interface SceneWindow {
  startMs: number;
  endMs: number;
}

/**
 * Map every state/frame to its window on the final output timeline.
 * states-form: states[i].id -> frames[i]. frames-form: String(i) -> frames[i].
 */
function sceneWindows(trace: TraceReelTrace, manifest: RecordingManifest): Map<string, SceneWindow> {
  const map = new Map<string, SceneWindow>();
  const frames = manifest.frames;
  for (let i = 0; i < frames.length; i++) {
    const startMs = Math.round(frames[i].t);
    const endMs = i + 1 < frames.length ? Math.round(frames[i + 1].t) : Math.round(manifest.duration);
    const w: SceneWindow = { startMs, endMs: Math.max(endMs, startMs) };
    if (trace.states && trace.states[i]) map.set(trace.states[i].id, w);
    map.set(String(i), w);
  }
  return map;
}

const issue = (
  code: string,
  message: string,
  path?: string,
  suggestion?: string,
  detail?: AudioIssue["detail"],
): AudioIssue => ({ code, message, path, suggestion, detail });

/**
 * Validate the trace's audio declarations and resolve them onto the output
 * timeline. Returns a plan whose `errors` is non-empty when the build must
 * not proceed.
 */
export function planAudio(
  trace: TraceReelTrace,
  manifest: RecordingManifest,
  opts: PlanAudioOptions,
): AudioPlan {
  const errors: AudioIssue[] = [];
  const warnings: AudioIssue[] = [];
  const narration: PlannedNarrationClip[] = [];
  const videoDurationMs = Math.round(manifest.duration);
  const windows = sceneWindows(trace, manifest);

  const narrationClips = trace.narration ?? [];
  narrationClips.forEach((clip, index) => {
    const base = `/narration/${index}`;
    if (typeof clip.state !== "string" || !clip.state) {
      errors.push(issue("NARRATION_MISSING_STATE", "narration clip has no state reference", `${base}/state`,
        "Set \"state\" to a state id (states-form) or a 0-based frame index (frames-form)."));
      return;
    }
    const window = windows.get(clip.state);
    if (!window) {
      errors.push(issue("NARRATION_UNKNOWN_STATE",
        `narration clip references unknown state ${JSON.stringify(clip.state)}`, `${base}/state`,
        "Use a state id from the trace's states[], or a 0-based frame index as a string.",
        { state: clip.state }));
      return;
    }
    if (typeof clip.audio !== "string" || !clip.audio) {
      errors.push(issue("NARRATION_MISSING_AUDIO", "narration clip has no audio file", `${base}/audio`,
        "Point \"audio\" at the agent-generated MP3/WAV/M4A file for this scene."));
      return;
    }
    let abs: string;
    try {
      abs = resolveAudioPath(opts.baseDir, clip.audio);
    } catch (e) {
      errors.push(issue("AUDIO_PATH_OUTSIDE_BUNDLE", (e as Error).message, `${base}/audio`,
        "Keep audio files inside the trace/bundle directory and reference them relatively."));
      return;
    }
    if (!existsSync(abs)) {
      errors.push(issue("AUDIO_FILE_MISSING", `narration audio file not found: ${clip.audio}`, `${base}/audio`,
        "Generate the clip with the agent's TTS/voice capability and save it at this path."));
      return;
    }
    let probed;
    try {
      probed = probeAudioFile(abs);
    } catch (e) {
      errors.push(issue("AUDIO_UNDECODABLE", (e as Error).message, `${base}/audio`,
        "Supply a decodable MP3, WAV, or M4A/AAC file."));
      return;
    }
    if (!SUPPORTED_AUDIO_CODECS.has(probed.codec)) {
      warnings.push(issue("AUDIO_CODEC_UNUSUAL",
        `narration audio uses codec ${probed.codec}; MP3/WAV/M4A-AAC are the tested inputs`,
        `${base}/audio`, "Prefer MP3, WAV, or M4A/AAC for predictable results.",
        { codec: probed.codec }));
    }
    if (probed.durationMs <= 0) {
      errors.push(issue("AUDIO_ZERO_DURATION", `narration audio has zero duration: ${clip.audio}`, `${base}/audio`,
        "Re-render the clip — a zero-length file carries no narration."));
      return;
    }
    let startMs = window.startMs;
    let explicitStart = false;
    if (clip.startMs !== undefined) {
      if (!Number.isFinite(clip.startMs) || clip.startMs < 0) {
        errors.push(issue("NARRATION_NEGATIVE_START",
          `narration startMs must be >= 0, got ${clip.startMs}`, `${base}/startMs`,
          "Omit startMs for state-based placement, or use a non-negative output-timeline time."));
        return;
      }
      startMs = Math.round(clip.startMs);
      explicitStart = true;
    }
    const sceneDurationMs = window.endMs - window.startMs;
    const overflowMs = Math.max(0, probed.durationMs - sceneDurationMs);
    if (overflowMs > 0) {
      warnings.push(issue("NARRATION_EXCEEDS_SCENE",
        `narration for state ${JSON.stringify(clip.state)} is ${probed.durationMs}ms but the scene is ${sceneDurationMs}ms`,
        `${base}/audio`,
        "Shorten the narration or adjust the scene timing.",
        { state: clip.state, sceneDurationMs, audioDurationMs: probed.durationMs }));
    }
    if (startMs + probed.durationMs > videoDurationMs) {
      warnings.push(issue("NARRATION_PAST_VIDEO_END",
        `narration for state ${JSON.stringify(clip.state)} runs past the end of the video and will be trimmed`,
        base, "Shorten the narration or move it earlier.",
        { state: clip.state, clipEndMs: startMs + probed.durationMs, videoDurationMs }));
    }
    narration.push({
      clip, index, startMs, explicitStart,
      sceneStartMs: window.startMs, sceneEndMs: window.endMs,
      audioDurationMs: probed.durationMs, overflowMs,
    });
  });

  // Overlapping narration clips: flag, don't fail — the mix sums them.
  const sorted = [...narration].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (cur.startMs < prev.startMs + prev.audioDurationMs) {
      warnings.push(issue("NARRATION_OVERLAP",
        `narration clips ${prev.index} and ${cur.index} overlap on the timeline and will play simultaneously`,
        `/narration/${cur.index}`, "Give each scene its own narration, or stagger them deliberately.",
        { clipA: prev.index, clipB: cur.index }));
    }
  }

  let music: PlannedMusic | null = null;
  const m = trace.audio?.music;
  if (m) {
    const base = "/audio/music";
    if (typeof m.file !== "string" || !m.file) {
      errors.push(issue("MUSIC_MISSING_FILE", "music config has no file", `${base}/file`,
        "Point \"file\" at the agent-supplied music file, or drop the music block."));
    } else {
      let abs: string | null = null;
      try {
        abs = resolveAudioPath(opts.baseDir, m.file);
      } catch (e) {
        errors.push(issue("AUDIO_PATH_OUTSIDE_BUNDLE", (e as Error).message, `${base}/file`,
          "Keep audio files inside the trace/bundle directory and reference them relatively."));
      }
      if (abs) {
        if (!existsSync(abs)) {
          errors.push(issue("AUDIO_FILE_MISSING", `music file not found: ${m.file}`, `${base}/file`,
            "Supply the music file at this path, or drop the music block."));
        } else {
          let probed;
          try {
            probed = probeAudioFile(abs);
          } catch (e) {
            errors.push(issue("AUDIO_UNDECODABLE", (e as Error).message, `${base}/file`,
              "Supply a decodable MP3, WAV, or M4A/AAC file."));
            probed = null;
          }
          if (probed) {
            if (probed.durationMs <= 0) {
              errors.push(issue("AUDIO_ZERO_DURATION", `music file has zero duration: ${m.file}`, `${base}/file`,
                "Supply a real music file, or drop the music block."));
            } else {
              const volume = m.volume ?? 0.1;
              const fadeInMs = m.fadeInMs ?? 0;
              const fadeOutMs = m.fadeOutMs ?? 0;
              const loop = m.loop ?? true;
              const duckUnderNarration = m.duckUnderNarration ?? false;
              if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
                errors.push(issue("MUSIC_INVALID_VOLUME",
                  `music volume must be between 0 and 1, got ${m.volume}`, `${base}/volume`,
                  "Use e.g. 0.10 for quiet background music."));
              }
              for (const [name, v] of [["fadeInMs", fadeInMs], ["fadeOutMs", fadeOutMs]] as const) {
                if (!Number.isFinite(v) || v < 0) {
                  errors.push(issue("MUSIC_INVALID_FADE",
                    `music ${name} must be >= 0, got ${v}`, `${base}/${name}`,
                    "Use 0 for no fade, or a positive millisecond value."));
                }
              }
              if (fadeInMs + fadeOutMs > videoDurationMs) {
                errors.push(issue("MUSIC_INVALID_FADE",
                  `music fades (${fadeInMs}ms in + ${fadeOutMs}ms out) exceed the video duration (${videoDurationMs}ms)`,
                  base, "Shorten the fades so they fit inside the video."));
              }
              music = {
                music: m,
                fileDurationMs: probed.durationMs,
                targetDurationMs: videoDurationMs,
                loops: loop && probed.durationMs < videoDurationMs,
                volume, fadeInMs: Math.round(fadeInMs), fadeOutMs: Math.round(fadeOutMs),
                duckUnderNarration,
              };
              if (!loop && probed.durationMs < videoDurationMs) {
                warnings.push(issue("MUSIC_ENDS_EARLY",
                  `music is ${probed.durationMs}ms but the video is ${videoDurationMs}ms; the tail will be silent`,
                  `${base}/loop`, "Set loop: true, or supply a longer track.",
                  { fileDurationMs: probed.durationMs, videoDurationMs }));
              }
            }
          }
        }
      }
    }
  }

  return { narration, music, loudness: planLoudness(trace, opts, errors, warnings), videoDurationMs, errors, warnings };
}

/**
 * Resolve the final loudness-normalization plan from trace.audio.loudness,
 * with CLI overrides taking precedence when set. Validation failures are
 * errors: the build must not proceed with a nonsense target.
 */
function planLoudness(
  trace: TraceReelTrace,
  opts: PlanAudioOptions,
  errors: AudioIssue[],
  warnings: AudioIssue[],
): PlannedLoudness {
  const base = "/audio/loudness";
  const t = trace.audio?.loudness ?? {};
  const o = opts.loudnessOverride ?? {};
  const disabled = o.disabled ?? t.disabled ?? false;

  const rawTarget = o.targetLUFS ?? t.targetLUFS ?? LOUDNESS_DEFAULTS.targetLUFS;
  const rawPeak = o.maxTruePeakDbTP ?? t.maxTruePeakDbTP ?? LOUDNESS_DEFAULTS.maxTruePeakDbTP;

  let targetLUFS = LOUDNESS_DEFAULTS.targetLUFS;
  if (!Number.isFinite(rawTarget) || rawTarget > 0 || rawTarget < -70) {
    errors.push(issue("LOUDNESS_INVALID_TARGET",
      `loudness targetLUFS must be a finite number between -70 and 0, got ${rawTarget}`,
      `${base}/targetLUFS`, "Use e.g. -16 for polished speech-heavy programs."));
  } else {
    targetLUFS = rawTarget;
  }
  let maxTruePeakDbTP = LOUDNESS_DEFAULTS.maxTruePeakDbTP;
  if (!Number.isFinite(rawPeak) || rawPeak > 0) {
    errors.push(issue("LOUDNESS_INVALID_PEAK",
      `loudness maxTruePeakDbTP must be a finite number <= 0, got ${rawPeak}`,
      `${base}/maxTruePeakDbTP`, "Use e.g. -1.5 to leave headroom against clipping."));
  } else {
    maxTruePeakDbTP = rawPeak;
  }

  if (!disabled && targetLUFS > maxTruePeakDbTP) {
    // The integrated target sits above the true-peak ceiling: the average
    // level cannot exceed the peak ceiling, so the limiter would clamp the
    // program constantly. Flag the contradictory config.
    warnings.push(issue("LOUDNESS_TARGET_ABOVE_PEAK",
      `loudness target ${targetLUFS} LUFS sits above the true-peak ceiling ${maxTruePeakDbTP} dBTP; the limiter will clamp the program`,
      base, "Lower targetLUFS or raise maxTruePeakDbTP."));
  }

  return {
    enabled: !disabled,
    targetLUFS,
    maxTruePeakDbTP,
    targetLRA: LOUDNESS_DEFAULTS.targetLRA,
  };
}
