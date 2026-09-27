/**
 * Subtitles from narration: the simplest honest mapping.
 *
 *   narration starts -> subtitle cue starts
 *   narration clip ends -> subtitle cue ends
 *   cue text = the clip's `text` (when the agent provided it)
 *
 * This never replaces TraceReel's existing burned-in captions; it is an
 * optional sidecar export (.srt / .vtt) for players that support subtitles.
 * Clips without text produce no cue — TraceReel never invents subtitle text.
 */
import type { AudioPlan, SubtitleCue } from "./types.js";

/** Build subtitle cues from a validated audio plan. */
export function cuesFromPlan(plan: AudioPlan): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const p of plan.narration) {
    const text = p.clip.text?.trim();
    if (!text) continue;
    cues.push({
      startMs: p.startMs,
      endMs: Math.min(p.startMs + p.audioDurationMs, plan.videoDurationMs),
      text,
    });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

function tsSrt(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)},${pad(milli, 3)}`;
}

function tsVtt(ms: number): string {
  return tsSrt(ms).replace(",", ".");
}

/** Render cues as SubRip. */
export function cuesToSrt(cues: SubtitleCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${tsSrt(c.startMs)} --> ${tsSrt(c.endMs)}\n${c.text}\n`)
    .join("\n");
}

/** Render cues as WebVTT. */
export function cuesToVtt(cues: SubtitleCue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${tsVtt(c.startMs)} --> ${tsVtt(c.endMs)}\n${c.text}\n`).join("\n")}`;
}
