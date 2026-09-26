/**
 * Visual regression gate for the reconstruction pipeline (manual/local, not CI).
 *
 * For each fixture in tests/fixtures/visual/<name>/:
 *   1. `muse-takeone validate` (fails fast on invalid input)
 *   2. render at 640x360@15fps (fast, deterministic) with a contact sheet
 *   3. compare the contact sheet against tests/fixtures/visual/<name>/baseline.jpg
 *
 * Pixel comparison is done on raw RGB buffers via ffmpeg (no image deps):
 * a fixture fails when more than 2% of pixels differ by >40/255 on any channel,
 * or the mean absolute difference exceeds 8/255.
 *
 * Usage:
 *   node scripts/visual-qa.mjs            # check all fixtures against baselines
 *   node scripts/visual-qa.mjs --update   # (re)generate baselines from current code
 *   node scripts/visual-qa.mjs form       # check one fixture
 *
 * Chromium: uses TAKEONE_CHROMIUM_PATH or the playwright-bundled default resolved
 * by the CLI. Baselines are machine-sensitive (fonts); regenerate on this machine
 * with --update after touching the compositor, then review the diffs by eye.
 */
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const fixturesDir = join(root, "tests", "fixtures", "visual");
const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.filter((a) => !a.startsWith("--"));

const FIXTURES = ["form", "scroll", "nav"].filter((f) => !only.length || only.includes(f));
const W = 640, H = 360, FPS = 15;

function rawPixels(jpgPath) {
  const ff = join(root, "node_modules", "ffmpeg-static", "ffmpeg");
  const buf = execFileSync(ff, ["-v", "error", "-i", jpgPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return buf;
}

function compare(baseline, current) {
  const a = rawPixels(baseline), b = rawPixels(current);
  if (a.length !== b.length) return { ok: false, reason: `size mismatch (${a.length} vs ${b.length} bytes)` };
  let bad = 0, sum = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    if (d > 40) bad++;
  }
  const pixels = a.length / 3;
  const badFrac = bad / pixels, mean = sum / pixels;
  const ok = badFrac <= 0.02 && mean <= 8;
  return { ok, reason: ok ? undefined : `${(badFrac * 100).toFixed(2)}% pixels differ strongly (mean ${mean.toFixed(2)}/255)` };
}

let failed = 0;
for (const name of FIXTURES) {
  const dir = join(fixturesDir, name);
  const work = join(dir, ".visual-qa");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  console.log(`\n=== ${name} ===`);
  try {
    execFileSync(process.execPath, [cli, "validate", join(dir, "input.json")], { stdio: "pipe" });
    const out = execFileSync(
      process.execPath,
      [cli, "reconstruct", join(dir, "input.json"), "-o", join(work, "preview.mp4"),
        "--width", String(W), "--height", String(H), "--fps", String(FPS),
        "--work-dir", join(work, "rec"), "--require-source", "manual-screenshots"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const jsonStart = out.indexOf("{");
    const { keyframes } = JSON.parse(out.slice(jsonStart));
    if (!keyframes || !existsSync(keyframes)) throw new Error("no contact sheet produced");
    const baseline = join(dir, "baseline.jpg");
    if (update || !existsSync(baseline)) {
      copyFileSync(keyframes, baseline);
      console.log(`baseline ${update ? "updated" : "created"}: ${baseline}`);
    } else {
      const r = compare(baseline, keyframes);
      console.log(r.ok ? "PASS: contact sheet matches baseline" : `FAIL: ${r.reason}`);
      if (!r.ok) failed++;
    }
  } catch (e) {
    console.log(`FAIL: ${(e && e.message) || e}`);
    failed++;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} fixture(s) FAILED` : "\nall fixtures pass");
process.exitCode = failed ? 1 : 0;
