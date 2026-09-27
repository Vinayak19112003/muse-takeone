/**
 * Portable capture bundles: a directory named `<something>.tracereel/`
 * holding the trace, its screenshots, and metadata.
 *
 *   demo.tracereel/
 *   ├── trace.json        normalized TraceReel Trace v1 (states/actions or frames)
 *   ├── frames/           the screenshots, referenced relative to trace.json
 *   └── metadata.json     producer info, provenance, adapter warnings
 *
 * A normal directory is enough — no archive format. Everything stays
 * relative, so bundles can be copied, zipped, or committed.
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { TraceReelTrace } from "./trace/types.js";

export const BUNDLE_SUFFIX = ".tracereel";
export const TRACE_FILE = "trace.json";
export const FRAMES_DIR = "frames";
export const METADATA_FILE = "metadata.json";

export interface BundleMetadata {
  bundleVersion: 1;
  /** The agent that produced the trace, as declared in the trace source. */
  agent: string;
  /** Which adapter normalized the trace (adapter name). */
  adapter: string;
  /** When the bundle was written, ISO 8601. */
  bundledAt: string;
  /** trace.json form: "states" or "frames". */
  traceForm: "states" | "frames";
  /** Adapter warnings produced during normalization. */
  warnings: string[];
  /** Free-form producer info the caller adds. */
  producer?: string;
  /** Provenance note: reconstructed from real screenshots with a rebuilt cursor path. */
  provenanceNote: string;
}

export interface LoadedBundle {
  dir: string;
  trace: TraceReelTrace;
  metadata: BundleMetadata;
  /** Absolute paths of the frames in bundle order. */
  frameFiles: string[];
}

/** Collect the screenshot files a trace references, in trace order. */
export function traceScreenshotFiles(trace: TraceReelTrace): string[] {
  const files: string[] = [];
  for (const s of trace.states ?? []) files.push(s.screenshot);
  for (const f of trace.frames ?? []) files.push(f.file);
  for (const seg of trace.videoSegments ?? []) {
    if (seg.file) files.push(seg.file);
  }
  return files;
}

/**
 * Write a normalized trace to `<dir>` as a bundle. Screenshots are copied
 * from `framesSourceDir` (where trace-relative paths currently point) into
 * `frames/`, and the trace's paths are rewritten to `frames/<basename>`.
 */
export function writeBundle(
  dir: string,
  trace: TraceReelTrace,
  opts: {
    framesSourceDir: string;
    adapter: string;
    warnings?: string[];
    producer?: string;
  },
): { dir: string; metadata: BundleMetadata } {
  const bundleDir = dir.endsWith(BUNDLE_SUFFIX) ? dir : dir + BUNDLE_SUFFIX;
  const abs = resolve(bundleDir);
  const framesDir = join(abs, FRAMES_DIR);
  mkdirSync(framesDir, { recursive: true });

  const rewritten: TraceReelTrace = structuredClone(trace);
  const copied: string[] = [];
  for (const f of traceScreenshotFiles(rewritten)) {
    const src = resolve(opts.framesSourceDir, f);
    if (!existsSync(src)) {
      throw new Error(`screenshot not found: ${src}`);
    }
    const destName = basename(f);
    copyFileSync(src, join(framesDir, destName));
    copied.push(destName);
  }
  const rewrite = (p: string) => join(FRAMES_DIR, basename(p));
  for (const s of rewritten.states ?? []) s.screenshot = rewrite(s.screenshot);
  for (const f of rewritten.frames ?? []) f.file = rewrite(f.file);
  for (const seg of rewritten.videoSegments ?? []) {
    if (seg.file) seg.file = rewrite(seg.file);
  }
  if (rewritten.screenshotsDir !== undefined) delete rewritten.screenshotsDir;

  writeFileSync(join(abs, TRACE_FILE), JSON.stringify(rewritten, null, 2) + "\n");
  const metadata: BundleMetadata = {
    bundleVersion: 1,
    agent: trace.source?.agent ?? "unknown",
    adapter: opts.adapter,
    bundledAt: new Date().toISOString(),
    traceForm: trace.states ? "states" : "frames",
    warnings: opts.warnings ?? [],
    producer: opts.producer,
    provenanceNote:
      "Reconstructed from real screenshots with a rebuilt cursor path — not a live recording.",
  };
  writeFileSync(join(abs, METADATA_FILE), JSON.stringify(metadata, null, 2) + "\n");
  return { dir: abs, metadata };
}

/** Load a bundle written by writeBundle. Throws when the layout is broken. */
export function loadBundle(dir: string): LoadedBundle {
  const abs = resolve(dir);
  const tracePath = join(abs, TRACE_FILE);
  if (!existsSync(tracePath)) {
    throw new Error(`not a TraceReel bundle: ${tracePath} is missing`);
  }
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as TraceReelTrace;
  const metaPath = join(abs, METADATA_FILE);
  const metadata = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as BundleMetadata)
    : ({
        bundleVersion: 1,
        agent: trace.source?.agent ?? "unknown",
        adapter: "unknown",
        bundledAt: "",
        traceForm: trace.states ? "states" : "frames",
        warnings: [],
        provenanceNote: "",
      } satisfies BundleMetadata);
  const frameFiles = traceScreenshotFiles(trace).map((f) => resolve(abs, f));
  for (const f of frameFiles) {
    if (!existsSync(f)) throw new Error(`bundle is missing frame: ${f}`);
  }
  return { dir: abs, trace, metadata, frameFiles };
}

/** True when the path looks like a bundle directory. */
export function isBundleDir(dir: string): boolean {
  return existsSync(join(resolve(dir), TRACE_FILE));
}
