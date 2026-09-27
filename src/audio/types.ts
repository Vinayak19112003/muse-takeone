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
export interface PlannedMusic {
  /** The trace's music config. */
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

/** The complete, validated audio build plan. */
export interface AudioPlan {
  /** Narration placements in trace order. */
  narration: PlannedNarrationClip[];
  /** Music plan, when the trace supplies music. */
  music: PlannedMusic | null;
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
