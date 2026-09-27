/**
 * TraceReel audio: agent-supplied narration + music, mixed and muxed onto the
 * finished video with the video stream copied, never re-encoded.
 *
 * TraceReel never generates voice or music. The agent renders narration with
 * its own TTS/voice capability and hands TraceReel the finished audio files;
 * this module handles scene timing, placement, mixing, ducking, fades,
 * clipping protection, AAC output, and audio QA.
 */
export type {
  AudioProbeResult,
  PlannedNarrationClip,
  PlannedMusic,
  AudioPlan,
  AudioIssue,
  AudioQaMetrics,
  AudioQaReport,
  SubtitleCue,
} from "./types.js";
export { AUDIO_OUTPUT, SUPPORTED_AUDIO_CODECS } from "./types.js";
export { resolveFfprobe, probeAudioFile } from "./probe.js";
export { planAudio, resolveAudioPath, type PlanAudioOptions } from "./plan.js";
export { buildMixSpec, planInputFiles, type MixSpec } from "./mix.js";
export {
  muxAudio,
  videoFrameHashes,
  videoStreamCodec,
  type MuxAudioOptions,
  type MuxAudioResult,
} from "./mux.js";
export { qaAudio, type QaAudioOptions } from "./qa.js";
export { cuesFromPlan, cuesToSrt, cuesToVtt } from "./subtitles.js";
