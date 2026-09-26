/**
 * Redact regions of a screenshot before rendering, using ffmpeg filters.
 *
 * Redactions run at frame-copy time in `writeReconstructionDir`, so the pixels never
 * reach the compositor or the output video. Modes:
 * - blur: heavy gaussian-ish blur over the region (boxblur, two passes).
 * - solid: opaque black box.
 * - pixelate: mosaic via downscale/upscale with nearest neighbour.
 *
 * This is a best-effort privacy helper, not a guarantee: it only hides what the
 * regions cover, so inspect the rendered frames before publishing.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { resolveFfmpeg } from "../ffmpeg.js";
import type { RedactionRegion } from "./build.js";

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * Apply redaction regions to `src` and write the result to `dest`.
 * Regions are clipped to the viewport; empty regions after clipping are skipped.
 */
export function applyRedactions(
  src: string,
  dest: string,
  regions: RedactionRegion[],
  viewport: { width: number; height: number },
  log: (msg: string) => void = () => {},
): void {
  const valid = regions
    .map((r) => ({
      x: clampInt(r.x, 0, viewport.width),
      y: clampInt(r.y, 0, viewport.height),
      w: clampInt(r.width, 0, viewport.width),
      h: clampInt(r.height, 0, viewport.height),
      mode: r.mode,
    }))
    .filter((r) => r.w > 0 && r.h > 0)
    .map((r) => ({
      ...r,
      w: Math.min(r.w, viewport.width - r.x),
      h: Math.min(r.h, viewport.height - r.y),
    }))
    .filter((r) => r.w > 0 && r.h > 0);
  if (!valid.length) {
    log("redact: all regions empty after clipping, copying unmodified");
    copyFileSync(src, dest);
    return;
  }
  // Chain one filter stage per region: [in] -> ... -> [outN].
  const parts: string[] = [];
  let cur = "0:v";
  valid.forEach((r, i) => {
    const out = `r${i}`;
    if (r.mode === "solid") {
      parts.push(`[${cur}]drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=black:t=fill[${out}]`);
    } else if (r.mode === "pixelate") {
      parts.push(
        `[${cur}]crop=${r.w}:${r.h}:${r.x}:${r.y},scale=iw/12:ih/12:flags=neighbor,scale=iw*12:ih*12:flags=neighbor[fg${i}];` +
          `[${cur}][fg${i}]overlay=${r.x}:${r.y}[${out}]`,
      );
    } else {
      parts.push(
        `[${cur}]crop=${r.w}:${r.h}:${r.x}:${r.y},boxblur=luma_radius=14:luma_power=2[fg${i}];` +
          `[${cur}][fg${i}]overlay=${r.x}:${r.y}[${out}]`,
      );
    }
    cur = out;
  });
  const graph = parts.join(";");
  log(`redact: ${valid.length} region(s) (${valid.map((r) => r.mode).join(", ")})`);
  execFileSync(resolveFfmpeg(), [
    "-y",
    "-i", src,
    "-filter_complex", graph,
    "-map", `[${cur}]`,
    "-frames:v", "1",
    dest,
  ], { stdio: "pipe" });
}
