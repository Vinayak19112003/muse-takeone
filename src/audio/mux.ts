/**
 * Mux: attach the mixed audio to the finished video.
 *
 * Hard requirement: the video stream is NEVER re-encoded. The mux is a single
 * FFmpeg invocation (two when loudness normalization is enabled: mix to a
 * temp PCM file first, measure it, then apply two-pass loudnorm):
 *
 *   ffmpeg -i video.mp4 -i narr1.mp3 ... -i music.m4a \
 *     -filter_complex "<mix graph>" \
 *     -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 \
 *     -movflags +faststart out.mp4
 *
 * `-c:v copy` means the video frames are bit-identical to the input;
 * `muxAudio` verifies this after the run by comparing per-stream frame hashes.
 *
 * Loudness normalization (default on, -16 LUFS / -1.5 dBTP) runs after the
 * mix via two-pass loudnorm with linear=true: constant gain, deterministic
 * for fixed inputs, true-peak limiting active so it can never clip. It does
 * not touch scene timing, the ducking graph, or the video stream.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveFfmpeg } from "../ffmpeg.js";
import { resolveFfprobe } from "./probe.js";
import { buildMixSpec } from "./mix.js";
import { measureLoudness, loudnormApplyFilter } from "./loudness.js";
import type { AudioPlan } from "./types.js";
import { AUDIO_OUTPUT } from "./types.js";

export interface MuxAudioOptions {
  /** The finished silent (or already-audio) video. Its stream is copied. */
  videoFile: string;
  /** Validated audio plan (errors must be empty). */
  plan: AudioPlan;
  /** Directory trace-relative audio paths resolve against. */
  baseDir: string;
  /** Output path for the final MP4. */
  outFile: string;
  /** Extra ffmpeg log lines for debugging. */
  verbose?: boolean;
}

export interface MuxAudioResult {
  outFile: string;
  /** Video stream codec of the output (should equal the input's). */
  videoCodec: string;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
}

/**
 * Frame hashes (per decoded video frame) for a file, used to prove the video
 * stream survived the mux untouched.
 */
export function videoFrameHashes(path: string): string[] {
  const out = execFileSync(
    resolveFfmpeg(),
    [
      "-hide_banner", "-v", "error",
      "-i", path,
      "-map", "0:v:0",
      "-f", "hash", "-hash", "md5", "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.trim().split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Codec name of the first video stream, via ffprobe. */
export function videoStreamCodec(path: string): string {
  const out = execFileSync(
    resolveFfprobe(),
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
    { encoding: "utf8" },
  );
  return out.trim().split("\n")[0]?.trim() ?? "";
}

export function muxAudio(opts: MuxAudioOptions): MuxAudioResult {
  if (opts.plan.errors.length > 0) {
    const first = opts.plan.errors[0];
    throw new Error(`audio plan has ${opts.plan.errors.length} error(s); first: ${first.code}: ${first.message}`);
  }
  if (!existsSync(opts.videoFile)) throw new Error(`video file not found: ${opts.videoFile}`);

  const spec = buildMixSpec(opts.plan, opts.baseDir);
  const ffmpeg = resolveFfmpeg();

  if (opts.plan.loudness.enabled) {
    muxWithLoudness(opts, spec, ffmpeg);
  } else {
    const args: string[] = ["-hide_banner", "-loglevel", "error", "-y", "-i", opts.videoFile];
    for (const f of spec.inputFiles) args.push("-i", f);
    args.push(
      "-filter_complex", spec.filterComplex,
      "-map", "0:v",
      "-map", spec.audioOutLabel,
      "-c:v", "copy",
      "-c:a", AUDIO_OUTPUT.codec,
      "-b:a", AUDIO_OUTPUT.bitrate,
      "-ar", String(AUDIO_OUTPUT.sampleRate),
      "-ac", String(AUDIO_OUTPUT.channels),
      "-movflags", "+faststart",
      opts.outFile,
    );
    if (opts.verbose) console.error(`[tracereel] ffmpeg ${args.join(" ")}`);
    execFileSync(ffmpeg, args, { stdio: opts.verbose ? "inherit" : "pipe", maxBuffer: 64 * 1024 * 1024 });
  }

  // Prove the video stream was copied, not re-encoded.
  const before = videoFrameHashes(opts.videoFile);
  const after = videoFrameHashes(opts.outFile);
  if (before.length !== after.length || before.some((h, i) => h !== after[i])) {
    throw new Error(
      `video stream changed during audio mux (${before.length} vs ${after.length} frame hashes) — refusing to ship a re-encoded video`,
    );
  }

  const probe = execFileSync(
    resolveFfprobe(),
    ["-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", opts.outFile],
    { encoding: "utf8" },
  );
  const aStream = (JSON.parse(probe) as { streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }> }).streams?.[0] ?? {};
  return {
    outFile: opts.outFile,
    videoCodec: videoStreamCodec(opts.outFile),
    audioCodec: aStream.codec_name ?? "",
    audioSampleRate: Number(aStream.sample_rate ?? 0),
    audioChannels: aStream.channels ?? 0,
  };
}

/**
 * Loudness-normalized mux: render the mix (ducking included) to a temp PCM
 * file, measure it with loudnorm pass 1, then apply the measured linear gain
 * plus true-peak limiting while muxing with the copied video stream.
 */
function muxWithLoudness(
  opts: MuxAudioOptions,
  spec: { inputFiles: string[]; filterComplex: string; audioOutLabel: string },
  ffmpeg: string,
): void {
  const tmpMix = join(tmpdir(), `tracereel-mix-${randomUUID()}.wav`);
  try {
    // Run 1: the exact same mix graph, rendered to lossless PCM.
    const mixArgs: string[] = ["-hide_banner", "-loglevel", "error", "-y", "-i", opts.videoFile];
    for (const f of spec.inputFiles) mixArgs.push("-i", f);
    mixArgs.push(
      "-filter_complex", spec.filterComplex,
      "-map", spec.audioOutLabel,
      "-c:a", "pcm_s16le",
      "-ar", String(AUDIO_OUTPUT.sampleRate),
      "-ac", String(AUDIO_OUTPUT.channels),
      tmpMix,
    );
    if (opts.verbose) console.error(`[tracereel] ffmpeg ${mixArgs.join(" ")}`);
    execFileSync(ffmpeg, mixArgs, { stdio: opts.verbose ? "inherit" : "pipe", maxBuffer: 64 * 1024 * 1024 });

    // Pass 1: measure the finished mix.
    const measured = measureLoudness(tmpMix, opts.plan.loudness);

    // Run 2: apply the measured linear gain + true-peak limit, mux with -c:v copy.
    const normFilter = loudnormApplyFilter(opts.plan.loudness, measured);
    const muxArgs: string[] = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", opts.videoFile,
      "-i", tmpMix,
      "-af", normFilter,
      "-map", "0:v",
      "-map", "1:a",
      "-c:v", "copy",
      "-c:a", AUDIO_OUTPUT.codec,
      "-b:a", AUDIO_OUTPUT.bitrate,
      "-ar", String(AUDIO_OUTPUT.sampleRate),
      "-ac", String(AUDIO_OUTPUT.channels),
      "-movflags", "+faststart",
      opts.outFile,
    ];
    if (opts.verbose) console.error(`[tracereel] ffmpeg ${muxArgs.join(" ")}`);
    execFileSync(ffmpeg, muxArgs, { stdio: opts.verbose ? "inherit" : "pipe", maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(tmpMix, { force: true });
  }
}
