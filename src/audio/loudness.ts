/**
 * Loudness normalization: final mastering stage for the mixed program audio.
 *
 * Runs AFTER mixing and ducking, via FFmpeg's two-pass loudnorm with
 * linear=true (constant gain — deterministic for fixed inputs, no dynamic
 * range reshaping that could fight the ducking):
 *
 *   pass 1 (measure): loudnorm=I=..:TP=..:LRA=..:print_format=json -f null -
 *   pass 2 (apply):   loudnorm=I=..:TP=..:LRA=..:measured_I=..:measured_TP=..:
 *                     measured_LRA=..:measured_thresh=..:offset=..:linear=true
 *
 * The true-peak limiter stays active in both passes, so normalization can
 * never introduce clipping. Scene timing, the ducking graph, and the video
 * stream are untouched by this stage.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolveFfmpeg } from "../ffmpeg.js";
import type { PlannedLoudness } from "./types.js";

export interface LoudnessMeasurement {
  /** Measured integrated loudness, LUFS. */
  integratedLufs: number;
  /** Measured true peak, dBTP. */
  truePeakDbTP: number;
  /** Measured loudness range, LU. */
  loudnessRange: number;
  /** Measured threshold, dB. */
  thresholdDb: number;
  /** Target offset for pass 2. */
  targetOffset: number;
}

interface LoudnormJson {
  input_i?: string;
  input_tp?: string;
  input_lra?: string;
  input_thresh?: string;
  target_offset?: string;
}

const num = (v: string | undefined, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`loudnorm measurement missing ${name}`);
  return n;
};

/**
 * Pass 1: measure the integrated loudness / true peak of a finished mix.
 * Deterministic for a fixed input file and FFmpeg build.
 */
export function measureLoudness(mixFile: string, plan: PlannedLoudness): LoudnessMeasurement {
  const filter =
    `loudnorm=I=${plan.targetLUFS}:TP=${plan.maxTruePeakDbTP}:LRA=${plan.targetLRA}:print_format=json`;
  const res = spawnSync(
    resolveFfmpeg(),
    ["-hide_banner", "-v", "info", "-i", mixFile, "-af", filter, "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const stderr = res.stderr ?? "";
  // The JSON block is the last {...} in stderr.
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("loudnorm measurement produced no JSON (is the loudnorm filter available?)");
  }
  let parsed: LoudnormJson;
  try {
    parsed = JSON.parse(stderr.slice(start, end + 1)) as LoudnormJson;
  } catch {
    throw new Error("loudnorm measurement produced unparseable JSON");
  }
  return {
    integratedLufs: num(parsed.input_i, "input_i"),
    truePeakDbTP: num(parsed.input_tp, "input_tp"),
    loudnessRange: num(parsed.input_lra, "input_lra"),
    thresholdDb: num(parsed.input_thresh, "input_thresh"),
    targetOffset: num(parsed.target_offset, "target_offset"),
  };
}

/** Pass 2 filter: apply the measured values with a constant (linear) gain. */
export function loudnormApplyFilter(plan: PlannedLoudness, m: LoudnessMeasurement): string {
  const f = (v: number): string => v.toFixed(2);
  // Lossy AAC encoding overshoots the PCM true peak by ~0.1-0.5 dB, so the
  // filter targets slightly below the ceiling: the FINAL file is what must
  // respect maxTruePeakDbTP, not the pre-encode PCM.
  const filterTP = plan.maxTruePeakDbTP - CODEC_PEAK_HEADROOM_DB;
  return (
    `loudnorm=I=${plan.targetLUFS}:TP=${f(filterTP)}:LRA=${plan.targetLRA}` +
    `:measured_I=${f(m.integratedLufs)}:measured_TP=${f(m.truePeakDbTP)}` +
    `:measured_LRA=${f(m.loudnessRange)}:measured_thresh=${f(m.thresholdDb)}` +
    `:offset=${f(m.targetOffset)}:linear=true`
  );
}

/**
 * Extra true-peak headroom (dB) reserved for lossy-codec overshoot: the
 * loudnorm limiter works on PCM, but AAC encoding typically pushes peaks
 * ~0.1-0.5 dB higher. Only engages on material that hits the ceiling.
 */
export const CODEC_PEAK_HEADROOM_DB = 0.5;

/**
 * Measure a finished mix file's loudness for QA reporting (no normalization).
 * Returns nulls when the measurement fails rather than throwing.
 */
export function probeLoudness(mixFile: string): { integratedLufs: number | null; truePeakDbTP: number | null } {
  try {
    // Measure against a neutral target; only the INPUT values are used.
    const m = measureLoudness(mixFile, {
      enabled: true,
      targetLUFS: -16,
      maxTruePeakDbTP: -1.5,
      targetLRA: 11,
    });
    return { integratedLufs: m.integratedLufs, truePeakDbTP: m.truePeakDbTP };
  } catch {
    return { integratedLufs: null, truePeakDbTP: null };
  }
}

/** Quick check that this FFmpeg build carries the loudnorm filter. */
export function loudnormAvailable(): boolean {
  try {
    const out = execFileSync(resolveFfmpeg(), ["-hide_banner", "-h", "filter=loudnorm"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return /loudnorm/.test(out);
  } catch {
    return false;
  }
}
