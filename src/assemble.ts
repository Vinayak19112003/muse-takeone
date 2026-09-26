import { spawn, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { resolveFfmpeg } from "./ffmpeg.js";

export type AssembleMove = "in" | "out" | "left" | "right" | "still";

export interface AssembleFrame {
  file: string;
  caption?: string;
  /** seconds on screen. Default from script or --hold. */
  hold?: number;
  move?: AssembleMove;
}

export interface AssembleScript {
  title?: string;
  subtitle?: string;
  fps?: number;
  width?: number;
  height?: number;
  defaultHold?: number;
  titleHold?: number;
  frames: AssembleFrame[];
}

export interface AssembleOptions {
  framesDir: string;
  outFile?: string;
  scriptFile?: string;
  title?: string;
  noTitle?: boolean;
  hold?: number;
  fps?: number;
  width?: number;
  height?: number;
  log?: (msg: string) => void;
}

export interface AssembleResult {
  outFile: string;
  frames: number;
  durationSec: number;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Escape a file path for use inside an ffmpeg filter argument. */
function escPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

/**
 * Write text to a temp file and return a drawtext textfile= reference.
 * Inline text= breaks on apostrophes (ffmpeg's filter parser terminates the
 * quoted string at \'), so captions always go through files.
 */
function textFile(textDir: string, name: string, text: string): string {
  const p = join(textDir, name);
  writeFileSync(p, text);
  return `textfile='${escPath(p)}'`;
}

function hasFilter(bin: string, name: string): boolean {
  try {
    // NOTE: some ffmpeg builds exit 0 even for unknown filters, so check the output text.
    const out = execSync(`"${bin}" -hide_banner -h filter=${name}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.includes(`Filter ${name}`);
  } catch {
    return false;
  }
}

/** Find an ffmpeg binary with drawtext (needed for captions/title cards). */
function resolveFfmpegWithDrawtext(): string {
  const candidates: string[] = [];
  try {
    candidates.push(resolveFfmpeg());
  } catch {}
  try {
    const sys = execSync(process.platform === "win32" ? "where ffmpeg" : "which ffmpeg", { encoding: "utf8" }).trim().split("\n")[0];
    if (sys) candidates.push(sys);
  } catch {}
  for (const bin of candidates) {
    if (bin && existsSync(bin) && hasFilter(bin, "drawtext")) return bin;
  }
  throw new Error("No ffmpeg with the drawtext filter found (needed for captions). Install a full ffmpeg build.");
}

function findFont(): string {
  const known = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ];
  for (const f of known) if (existsSync(f)) return f;
  try {
    const out = execSync("find /usr/share/fonts -name '*.ttf' 2>/dev/null | head -1", { encoding: "utf8" }).trim();
    if (out) return out;
  } catch {}
  throw new Error("No TTF font found for captions. Install dejavu or liberation fonts.");
}

function autoScript(dir: string, hold: number): AssembleScript {
  const files = readdirSync(dir).filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase())).sort(naturalSort);
  if (!files.length) throw new Error(`No images found in ${dir}`);
  const moves: AssembleMove[] = ["in", "out", "left", "right"];
  return {
    defaultHold: hold,
    frames: files.map((file, i) => ({ file, hold, move: moves[i % moves.length] })),
  };
}

function loadScript(opts: AssembleOptions): AssembleScript {
  const dir = resolve(opts.framesDir);
  const explicit = opts.scriptFile ? resolve(opts.scriptFile) : join(dir, "assemble.json");
  if (existsSync(explicit)) {
    const raw = JSON.parse(readFileSync(explicit, "utf8")) as AssembleScript;
    if (!Array.isArray(raw.frames) || !raw.frames.length) throw new Error(`Script ${explicit} has no frames`);
    return raw;
  }
  if (opts.scriptFile) throw new Error(`Script file not found: ${explicit}`);
  return autoScript(dir, opts.hold ?? 3);
}

export async function assembleVideo(opts: AssembleOptions): Promise<AssembleResult> {
  const log = opts.log ?? (() => {});
  const dir = resolve(opts.framesDir);
  if (!existsSync(dir)) throw new Error(`Frames directory not found: ${dir}`);
  const script = loadScript(opts);
  const fps = opts.fps ?? script.fps ?? 30;
  const W = opts.width ?? script.width ?? 1920;
  const H = opts.height ?? script.height ?? 1080;
  const defaultHold = opts.hold ?? script.defaultHold ?? 3;
  const title = opts.noTitle ? undefined : (opts.title ?? script.title);
  const needsText = Boolean(title || script.subtitle || script.frames.some((f) => f.caption));

  const bin = needsText ? resolveFfmpegWithDrawtext() : resolveFfmpeg();
  const font = needsText ? findFont() : "";
  log(`Using ffmpeg: ${bin}${needsText ? ` (font: ${font})` : ""}`);

  // Validate frame files.
  const frames = script.frames.map((f) => {
    const p = resolve(dir, f.file);
    if (!existsSync(p)) throw new Error(`Frame not found: ${p}`);
    return { ...f, abs: p, hold: f.hold ?? defaultHold, move: f.move ?? "in" };
  });

  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  let idx = 0;

  // Captions go through text files: inline text= misparses apostrophes.
  const textDir = join(tmpdir(), `takeone-assemble-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(textDir, { recursive: true });
  let textN = 0;
  const cap = (text: string) => textFile(textDir, `t${textN++}.txt`, text);

  const pushSegment = (chain: string) => {
    const label = `v${labels.length}`;
    chains.push(`${chain}[${label}]`);
    labels.push(`[${label}]`);
  };

  // ---- Title card ----
  if (title) {
    const titleHold = script.titleHold ?? 2.5;
    inputs.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${fps}:d=${titleHold}`);
    const parts = [
      `drawtext=fontfile=${font}:${cap(title)}:fontsize=${Math.round(H / 15)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-40`,
    ];
    if (script.subtitle) {
      parts.push(
        `drawtext=fontfile=${font}:${cap(script.subtitle)}:fontsize=${Math.round(H / 30)}:fontcolor=#bbbbbb:x=(w-text_w)/2:y=(h-text_h)/2+60`,
      );
    }
    pushSegment(`[${idx}:v]${parts.join(",")},format=yuv420p`);
    idx++;
  }

  // ---- Photo segments with Ken Burns motion ----
  const PRE_W = 3840, PRE_H = 2160;
  frames.forEach((f, i) => {
    inputs.push("-i", f.abs);
    const n = Math.max(2, Math.round(f.hold * fps));
    const D = n - 1;
    const cover = `scale=${PRE_W}:${PRE_H}:force_original_aspect_ratio=increase,crop=${PRE_W}:${PRE_H}`;
    let motion: string;
    switch (f.move) {
      case "out":
        motion = `zoompan=z='1.15-0.15*on/${D}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${n}:s=${W}x${H}:fps=${fps}`;
        break;
      case "left":
        motion = `zoompan=z='1.12':x='(iw-iw/zoom)*(1-on/${D})':y='ih/2-(ih/zoom/2)':d=${n}:s=${W}x${H}:fps=${fps}`;
        break;
      case "right":
        motion = `zoompan=z='1.12':x='(iw-iw/zoom)*(on/${D})':y='ih/2-(ih/zoom/2)':d=${n}:s=${W}x${H}:fps=${fps}`;
        break;
      case "still":
        motion = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps}`;
        break;
      case "in":
      default:
        motion = `zoompan=z='1+0.15*on/${D}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${n}:s=${W}x${H}:fps=${fps}`;
        break;
    }
    const fx: string[] = f.move === "still" ? [motion] : [cover, motion];
    fx.push("setsar=1");
    if (f.caption) {
      fx.push(
        `drawtext=fontfile=${font}:${cap(f.caption)}:fontsize=${Math.round(H / 24)}:fontcolor=white:borderw=2:bordercolor=black@0.8:x=(w-text_w)/2:y=h-${Math.round(H / 9)}:box=1:boxcolor=black@0.55:boxborderw=24`,
      );
    }
    fx.push(`trim=duration=${f.hold}`, "setpts=PTS-STARTPTS");
    if (f.hold >= 1.2) {
      const fo = (f.hold - 0.4).toFixed(2);
      fx.push(`fade=t=in:st=0:d=0.4`, `fade=t=out:st=${fo}:d=0.4`);
    }
    fx.push("format=yuv420p");
    pushSegment(`[${idx}:v]${fx.join(",")}`);
    idx++;
    log(`Segment ${i + 1}/${frames.length}: ${f.file} (${f.hold}s, ${f.move}${f.caption ? ", captioned" : ""})`);
  });

  const filter = `${chains.join(";")};${labels.join("")}concat=n=${labels.length}:v=1:a=0[vout]`;
  if (process.env.TAKEONE_ASSEMBLE_DEBUG) log(`FILTER: ${filter}`);
  const outFile = resolve(opts.outFile ?? join(dir, "assemble-output.mp4"));
  const args = ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outFile];

  log(`Encoding ${labels.length} segments -> ${outFile}`);
  try {
    await new Promise<void>((resolveP, reject) => {
      const proc = spawn(bin, args, { stdio: ["ignore", "inherit", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolveP() : reject(new Error(`ffmpeg exited with ${code}\n${stderr}`))));
    });
  } finally {
    rmSync(textDir, { recursive: true, force: true });
  }

  const durationSec = (title ? (script.titleHold ?? 2.5) : 0) + frames.reduce((s, f) => s + f.hold, 0);
  log(`Done: ${outFile} (${durationSec.toFixed(1)}s)`);
  return { outFile, frames: frames.length, durationSec };
}
