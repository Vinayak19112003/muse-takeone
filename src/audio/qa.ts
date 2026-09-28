/**
 * Audio QA: concrete checks on the plan and (when available) the finished file.
 *
 * No fake subjective quality scores — only verifiable facts: clip counts,
 * onset times, overflows, missing files, clipping protection presence, codec,
 * sample rate, channels, music presence, ducking state, and silence detection.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveFfmpeg } from "../ffmpeg.js";
import { resolveFfprobe, probeAudioFile } from "./probe.js";
import { probeLoudness } from "./loudness.js";
import type { AudioPlan, AudioQaMetrics, AudioQaReport } from "./types.js";
import { AUDIO_OUTPUT } from "./types.js";

export interface QaAudioOptions {
  /** Finished muxed file to verify; when omitted, only plan-level checks run. */
  outFile?: string;
}

/** Mean and max volume of an audio stream in dB; nulls when unmeasurable.
 * volumedetect reports on stderr, so stderr (not stdout) is parsed. */
function volumeStats(path: string): { meanDb: number | null; maxDb: number | null } {
  try {
    const res = spawnSync(
      resolveFfmpeg(),
      ["-hide_banner", "-v", "info", "-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const stderr = res.stderr ?? "";
    const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
    const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
    return {
      meanDb: mean ? Number(mean[1]) : null,
      maxDb: max ? Number(max[1]) : null,
    };
  } catch {
    return { meanDb: null, maxDb: null };
  }
}

export function qaAudio(plan: AudioPlan, opts: QaAudioOptions = {}): AudioQaReport {
  const warnings: string[] = [];
  const onsets = plan.narration.map((p) => p.startMs);
  const overflowClips = plan.narration.filter((p) => p.overflowMs > 0).length;
  const narrationTotalMs = plan.narration.reduce((a, p) => a + p.audioDurationMs, 0);

  const metrics: AudioQaMetrics = {
    narrationClips: plan.narration.length,
    narrationTotalMs,
    narrationOnsetsMs: onsets,
    narrationOverflowClips: overflowClips,
    musicPresent: plan.music !== null,
    musicLoops: plan.music?.loops ?? false,
    musicVolume: plan.music?.volume ?? null,
    duckingEnabled: plan.music?.duckUnderNarration ?? false,
    finalCodec: null,
    finalSampleRate: null,
    finalChannels: null,
    finalDurationMs: null,
    silent: null,
    maxVolumeDb: null,
    loudnessNormalized: plan.loudness.enabled,
    loudnessTargetLufs: plan.loudness.enabled ? plan.loudness.targetLUFS : null,
    loudnessIntegratedLufs: null,
    loudnessTruePeakDbTP: null,
  };

  // Plan-level warnings (these mirror plan warnings as plain QA strings).
  for (const w of plan.warnings) warnings.push(`[audio] ${w.code}: ${w.message}`);
  if (plan.narration.length === 0 && !plan.music) {
    warnings.push("[audio] no narration clips and no music: the mix would be silent by construction");
  }

  const outFile = opts.outFile;
  if (outFile && existsSync(outFile)) {
    let streams: Array<{ codec_name?: string; sample_rate?: string; channels?: number }> = [];
    try {
      const raw = execFileSync(
        resolveFfprobe(),
        ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", outFile],
        { encoding: "utf8" },
      );
      streams = (JSON.parse(raw) as { streams?: typeof streams }).streams ?? [];
    } catch {}
    const a0 = streams[0];
    if (!a0) {
      warnings.push("[audio] final file has no audio stream");
      metrics.silent = true;
    } else {
      metrics.finalCodec = a0.codec_name ?? null;
      metrics.finalSampleRate = Number(a0.sample_rate ?? 0) || null;
      metrics.finalChannels = a0.channels ?? null;
      try {
        metrics.finalDurationMs = probeAudioFile(outFile).durationMs;
      } catch {}
      if (metrics.finalCodec !== AUDIO_OUTPUT.codec) {
        warnings.push(`[audio] final audio codec is ${metrics.finalCodec ?? "unknown"}, expected ${AUDIO_OUTPUT.codec}`);
      }
      if (metrics.finalSampleRate !== AUDIO_OUTPUT.sampleRate) {
        warnings.push(`[audio] final sample rate is ${metrics.finalSampleRate ?? "unknown"} Hz, expected ${AUDIO_OUTPUT.sampleRate} Hz`);
      }
      const { meanDb, maxDb } = volumeStats(outFile);
      if (meanDb !== null) {
        metrics.silent = meanDb <= -60;
        if (metrics.silent) warnings.push("[audio] final audio track is silent (mean volume <= -60 dB)");
      }
      if (maxDb !== null) {
        metrics.maxVolumeDb = maxDb;
        // The mix chain ends in alimiter=limit=0.95 (~-0.45 dB); a peak above
        // that means the limiter is not protecting the mix.
        if (maxDb > -0.4) warnings.push(`[audio] clipping risk: peak ${maxDb.toFixed(1)} dB exceeds the limiter ceiling`);
      }
      // Loudness QA: measure the finished file with EBU R128 loudnorm and
      // compare against the plan's targets.
      const { integratedLufs, truePeakDbTP } = probeLoudness(outFile);
      metrics.loudnessIntegratedLufs = integratedLufs;
      metrics.loudnessTruePeakDbTP = truePeakDbTP;
      if (plan.loudness.enabled) {
        if (integratedLufs !== null &&
            Math.abs(integratedLufs - plan.loudness.targetLUFS) > 1.0) {
          warnings.push(
            `[audio] loudness off target: measured ${integratedLufs.toFixed(1)} LUFS, target ${plan.loudness.targetLUFS} LUFS`);
        }
        if (truePeakDbTP !== null && truePeakDbTP > plan.loudness.maxTruePeakDbTP + 0.1) {
          warnings.push(
            `[audio] true peak ${truePeakDbTP.toFixed(1)} dBTP exceeds the ${plan.loudness.maxTruePeakDbTP} dBTP ceiling`);
        }
      }
    }
  }

  return { metrics, warnings };
}
