/**
 * Mix: turn an AudioPlan into an FFmpeg filter graph.
 *
 * Graph shape (input 0 is always the video; audio inputs follow):
 *
 *   narration clip i -> aresample -> stereo -> adelay to its scene start -> [n{i}]
 *   [n0][n1]... -> amix (duration=longest, no normalization) -> [narr]
 *
 *   music -> aresample -> stereo -> aloop -> atrim to video duration
 *         -> volume -> afade in/out -> [mus0]
 *   [mus0][narr] -> sidechaincompress (only when ducking enabled) -> [mus]
 *
 *   [mus][narr] (or whichever exist) -> amix -> alimiter (clip protection)
 *         -> atrim/apad to exactly the video duration -> 48kHz stereo -> [aout]
 *
 * Ducking uses sidechain compression keyed off the narration bus: while the
 * voice is active the music drops, then returns smoothly (attack/release).
 * It is deterministic for fixed inputs, parameters, and FFmpeg build.
 */
import { resolve } from "node:path";
import type { AudioPlan, PlannedMusic, PlannedNarrationClip } from "./types.js";
import { resolveAudioPath } from "./plan.js";

export interface MixSpec {
  /** Audio input files, in order; they follow input 0 (the video) in the ffmpeg command. */
  inputFiles: string[];
  /** The -filter_complex string. */
  filterComplex: string;
  /** Label of the finished audio stream, e.g. "[aout]". */
  audioOutLabel: string;
}

const s = (ms: number): string => (ms / 1000).toFixed(3);

/** Ducking parameters: audible but gentle, smooth return. */
const DUCK = {
  threshold: 0.02,
  ratio: 8,
  attack: 200,
  release: 600,
} as const;

export function buildMixSpec(plan: AudioPlan, baseDir: string): MixSpec {
  const inputFiles: string[] = [];
  const filters: string[] = [];
  const durS = s(plan.videoDurationMs);

  // Narration bus.
  const narrLabels: string[] = [];
  plan.narration.forEach((p: PlannedNarrationClip, k: number) => {
    const abs = resolveAudioPath(baseDir, p.clip.audio);
    const inIdx = inputFiles.length + 1; // input 0 is the video
    inputFiles.push(abs);
    const label = `n${k}`;
    narrLabels.push(`[${label}]`);
    // Stereo first so adelay's per-channel values line up.
    filters.push(
      `[${inIdx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${p.startMs}|${p.startMs}[${label}]`,
    );
  });
  let narrBus = "";
  if (narrLabels.length > 0) {
    narrBus = "narr";
    // Pad to the full video duration: downstream consumers (notably the
    // sidechaincompress sidechain) end when their shortest input ends, which
    // would truncate the music when the last narration clip finishes early.
    filters.push(
      `${narrLabels.join("")}amix=inputs=${narrLabels.length}:duration=longest:normalize=0,apad=whole_dur=${durS}[${narrBus}]`,
    );
  }

  // Music bus.
  let musicBus = "";
  const pm: PlannedMusic | null = plan.music;
  if (pm) {
    const abs = resolveAudioPath(baseDir, pm.music.file);
    const inIdx = inputFiles.length + 1;
    inputFiles.push(abs);
    const chain: string[] = [
      "aresample=48000",
      "aformat=channel_layouts=stereo",
      // Loop a effectively unbounded number of samples, then trim to the video.
      "aloop=loop=-1:size=2000000000",
      `atrim=0:${durS}`,
      "asetpts=PTS-STARTPTS",
      `volume=${pm.volume}`,
    ];
    if (pm.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${s(pm.fadeInMs)}`);
    if (pm.fadeOutMs > 0) {
      chain.push(`afade=t=out:st=${s(plan.videoDurationMs - pm.fadeOutMs)}:d=${s(pm.fadeOutMs)}`);
    }
    musicBus = "mus0";
    filters.push(`[${inIdx}:a]${chain.join(",")}[${musicBus}]`);
    if (pm.duckUnderNarration && narrBus) {
      // A filter output can only feed one consumer: split the narration bus so
      // one copy drives the sidechain and the other reaches the final mix.
      filters.push(`[${narrBus}]asplit=2[narr_sc][narr_mix]`);
      const ducked = "mus";
      filters.push(
        `[${musicBus}][narr_sc]sidechaincompress=threshold=${DUCK.threshold}:ratio=${DUCK.ratio}` +
          `:attack=${DUCK.attack}:release=${DUCK.release}[${ducked}]`,
      );
      musicBus = ducked;
      narrBus = "narr_mix";
    }
  }

  // Final mix: music + narration, clip protection, exact video duration, 48kHz stereo.
  const buses: string[] = [];
  if (musicBus) buses.push(`[${musicBus}]`);
  if (narrBus) buses.push(`[${narrBus}]`);
  if (buses.length === 0) {
    throw new Error("audio plan has neither narration nor music — nothing to mix");
  }
  const tail = [
    "alimiter=limit=0.95",
    `atrim=0:${durS}`,
    "asetpts=PTS-STARTPTS",
    `apad=whole_dur=${durS}`,
    "aresample=48000",
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
  ].join(",");
  if (buses.length === 1) {
    filters.push(`${buses[0]}${tail}[aout]`);
  } else {
    filters.push(`${buses.join("")}amix=inputs=${buses.length}:duration=longest:normalize=0,${tail}[aout]`);
  }

  return { inputFiles, filterComplex: filters.join(";\n"), audioOutLabel: "[aout]" };
}

/** Resolve every audio input to an absolute path (for logging / QA). */
export function planInputFiles(plan: AudioPlan, baseDir: string): string[] {
  const files: string[] = [];
  for (const p of plan.narration) files.push(resolve(resolveAudioPath(baseDir, p.clip.audio)));
  if (plan.music) files.push(resolve(resolveAudioPath(baseDir, plan.music.music.file)));
  return files;
}
