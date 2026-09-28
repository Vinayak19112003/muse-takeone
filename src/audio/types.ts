/**
 * TraceReel audio types: the agent-neutral narration/music model.
 *
 * The division of labor is fixed:
 *
 *   The AGENT handles: understanding the browser workflow, deciding what gets
 *   narrated, writing natural narration, rendering it with its OWN TTS/voice
 *   capability, and optionally supplying background music.
 *
 *   TraceReel handles: scene timing, audio placement, duration validation,
 *   voice/music mixing, fades, optional music ducking, loudness/clipping
 *   protection, subtitle timing metadata, AAC output, the final FFmpeg mux
 *   (video stream copied, never re-encoded), and audio QA.
 *
 * TraceReel never generates voice or music itself, and never claims to
 * provide TTS.
 */
import type { TraceMusic, TraceNarrationClip } from "../trace/types.js";

/** Result of inspecting one agent-supplied audio file with ffprobe. */
export interface AudioProbeResult {
  /** Absolute path that was probed. */
  path: string;
  /** Duration in ms, rounded. */
  durationMs: number;
  /** Codec name as ffprobe reports it, e.g. "mp3", "pcm_s16le", "aac". */
  codec: string;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Channel count. */
  channels: number;
}

/** One narration clip resolved onto the final output timeline. */
export interface PlannedNarrationClip {
  /** The trace's narration entry. */
  clip: TraceNarrationClip;
  /** 0-based index in trace.narration. */
  index: number;
  /** Resolved start on the final output timeline, in ms. */
  startMs: number;
  /** Whether startMs came from an explicit startMs override. */
  explicitStart: boolean;
  /** Output-timeline start of the owning scene, in ms. */
  sceneStartMs: number;
  /** Output-timeline end of the owning scene, in ms. */
  sceneEndMs: number;
  /** Probed narration audio duration, in ms. */
  audioDurationMs: number;
  /** audioDurationMs - (sceneEndMs - sceneStartMs), when positive. */
  overflowMs: number;
}

/** Background music resolved onto the final output timeline. */
export interface PlannedMusic {  /** The trace's music config. */
  music: TraceMusic;
  /** Probed music file duration, in ms. */
  fileDurationMs: number;
  /** Final video duration the music is trimmed/looped to, in ms. */
  targetDurationMs: number;
  /** Whether the file must loop to cover the target. */
  loops: boolean;
  /** Effective linear gain. */
  volume: number;
  /** Effective fade-in, ms. */
  fadeInMs: number;
  /** Effective fade-out, ms. */
  fadeOutMs: number;
  /** Effective ducking flag. */
  duckUnderNarration: boolean;
}

/**
 * Final loudness normalization resolved from the trace's audio.loudness.
 * Runs after mixing and ducking via FFmpeg's two-pass loudnorm (linear gain,
 * deterministic for fixed inputs): the mix is rendered once, measured, then a
 * constant gain plus true-peak limiting is applied to hit the target.
 */
export interface PlannedLoudness {
  /** Whether normalization runs. False when the trace sets disabled: true. */
  enabled: boolean;
  /** Effective target integrated loudness, LUFS. */
  targetLUFS: number;
  /** Effective maximum true peak, dBTP. */
  maxTruePeakDbTP: number;
  /** Loudness-range target, LU. Fixed at 11 (EBU R128 default). */
  targetLRA: number;
}

/** Default loudness targets: polished speech-heavy program level. */
export const LOUDNESS_DEFAULTS: { targetLUFS: number; maxTruePeakDbTP: number; targetLRA: number } = {
  targetLUFS: -16,
  maxTruePeakDbTP: -1.5,
  targetLRA: 11,
};

/** The complete, validated audio build plan. */
export interface AudioPlan {
  /** Narration placements in trace order. */
  narration: PlannedNarrationClip[];
  /** Music plan, when the trace supplies music. */
  music: PlannedMusic | null;
  /** Loudness normalization plan (enabled by default). */
  loudness: PlannedLoudness;
  /** Final output timeline duration (the video's), in ms. */
  videoDurationMs: number;
  /** Structured validation failures: the build must not proceed. */
  errors: AudioIssue[];
  /** Structured advisories: the build proceeds, the agent should look. */
  warnings: AudioIssue[];
}

/** Structured, agent-friendly audio issue. `code` is stable; never parse `message`. */
export interface AudioIssue {
  code: string;
  message: string;
  /** JSON-pointer-ish location in the trace, e.g. "/narration/1/audio". */
  path?: string;
  suggestion?: string;
  /** Extra machine-readable detail, e.g. durations for overflow. */
  detail?: Record<string, number | string | boolean | null>;
}

/** Audio QA metrics for a finished (or planned) mix. */
export interface AudioQaMetrics {
  narrationClips: number;
  narrationTotalMs: number;
  narrationOnsetsMs: number[];
  narrationOverflowClips: number;
  musicPresent: boolean;
  musicLoops: boolean;
  musicVolume: number | null;
  duckingEnabled: boolean;
  finalCodec: string | null;
  finalSampleRate: number | null;
  finalChannels: number | null;
  finalDurationMs: number | null;
  silent: boolean | null;
  /** Peak level of the final mix in dB (volumedetect max_volume); the mix
   *  limiter targets 0.95 (-0.45 dB), so peaks above that indicate the
   *  limiter is not in the chain. */
  maxVolumeDb: number | null;
  /** Whether loudness normalization ran on the final mix. */
  loudnessNormalized: boolean;
  /** Loudness target the run aimed for, LUFS (null when disabled). */
  loudnessTargetLufs: number | null;
  /** Measured integrated loudness of the final file, LUFS (EBU R128). */
  loudnessIntegratedLufs: number | null;
  /** Measured true peak of the final file, dBTP. */
  loudnessTruePeakDbTP: number | null;
}

export interface AudioQaReport {
  metrics: AudioQaMetrics;
  warnings: string[];
}

/** Subtitle cue derived from a narration placement. */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Final mix output format: AAC-LC, publishing-compatible. */
export const AUDIO_OUTPUT = {
  codec: "aac",
  sampleRate: 48000,
  channels: 2,
  bitrate: "192k",
} as const;

/** Supported narration/music container/codec inputs (agent-generated). */
export const SUPPORTED_AUDIO_CODECS = new Set([
  "mp3",
  "aac",
  "pcm_s16le",
  "pcm_s16be",
  "pcm_s24le",
  "pcm_s32le",
  "pcm_f32le",
  "alac",
  "vorbis",
  "opus",
  "flac",
]);
