/**
 * ffprobe wrapper: inspect agent-supplied audio files.
 *
 * TraceReel does not care which TTS engine produced a file (Muse TTS, a
 * Grokbot voice tool, another agent's pipeline, a human recording) — it only
 * needs the file to be a decodable MP3/WAV/M4A-AAC (or similar) with a real
 * duration.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AudioProbeResult } from "./types.js";

export function resolveFfprobe(): string {
  const fromEnv = process.env.FFPROBE_PATH ?? process.env.TRACEREEL_FFPROBE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`ffprobe not found at ${fromEnv}`);
    return fromEnv;
  }
  try {
    const which = process.platform === "win32" ? "where ffprobe" : "which ffprobe";
    const out = execSync(which, { encoding: "utf8" }).trim().split("\n")[0];
    if (out && existsSync(out)) return out;
  } catch {}
  throw new Error(
    "ffprobe not found. Install ffprobe (it ships with ffmpeg) or set FFPROBE_PATH.",
  );
}

interface FfprobeJson {
  streams?: Array<{
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    duration?: string;
  }>;
  format?: { duration?: string };
}

/** Probe one audio file. Throws a descriptive Error when it is missing or undecodable. */
export function probeAudioFile(path: string): AudioProbeResult {
  if (!existsSync(path)) {
    throw new Error(`audio file not found: ${path}`);
  }
  let raw: string;
  try {
    raw = execFileSync(
      resolveFfprobe(),
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,duration",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
  } catch (e) {
    throw new Error(`audio file is not decodable: ${path} (${(e as Error).message.split("\n")[0]})`);
  }
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(raw) as FfprobeJson;
  } catch {
    throw new Error(`audio file is not decodable: ${path} (ffprobe returned unparseable output)`);
  }
  const stream = (parsed.streams ?? []).find((s) => s.codec_name) ?? parsed.streams?.[0];
  const durationSec =
    Number(stream?.duration ?? NaN) || Number(parsed.format?.duration ?? NaN) || NaN;
  if (!stream?.codec_name || !Number.isFinite(durationSec)) {
    throw new Error(`audio file is not decodable: ${path} (no audio stream or duration found)`);
  }
  return {
    path,
    durationMs: Math.round(durationSec * 1000),
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate ?? 0) || 0,
    channels: stream.channels ?? 0,
  };
}
