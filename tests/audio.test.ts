/**
 * TraceReel audio tests: agent-supplied narration + music.
 *
 * Fixtures are synthesized at test time with ffmpeg (sine tones stand in for
 * agent TTS clips) — deterministic, public-safe, no binary blobs in the repo.
 *
 * Covers: state-timed placement, multiple clips, MP3/WAV/M4A inputs, music
 * loop/volume/fades, ducking, NARRATION_EXCEEDS_SCENE, missing audio, path
 * traversal rejection, final MP4 audio stream, unchanged video frames, and
 * no-audio backward compatibility.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReconstructionManifest } from "../src/reconstruct/build.js";
import { RECONSTRUCTION_DEFAULTS, resolveConfig } from "../src/config.js";
import { traceToReconstructionInput } from "../src/adapters/normalize.js";
import { probeAudioFile } from "../src/audio/probe.js";
import { planAudio, resolveAudioPath } from "../src/audio/plan.js";
import { buildMixSpec } from "../src/audio/mix.js";
import { muxAudio, videoFrameHashes } from "../src/audio/mux.js";
import { qaAudio } from "../src/audio/qa.js";
import { cuesFromPlan, cuesToSrt, cuesToVtt } from "../src/audio/subtitles.js";
import { writeBundle, loadBundle } from "../src/bundle.js";
import type { TraceReelTrace } from "../src/trace/types.js";
import { resolveFfmpeg } from "../src/ffmpeg.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureFrames = join(here, "fixtures", "qa", "frames");

const ffmpeg = (): string => resolveFfmpeg();

/** Sine tone standing in for an agent-generated TTS clip. */
function tone(out: string, seconds: number, freq = 440, sampleRate = 44100): void {
  execFileSync(
    ffmpeg(),
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", `sine=frequency=${freq}:duration=${seconds}`,
      "-ar", String(sampleRate), out],
    { stdio: "pipe" },
  );
}

interface AudioFixture {
  dir: string;
  trace: TraceReelTrace;
  manifest: ReturnType<typeof buildReconstructionManifest>;
}

/** Three states with generous holds, narration in MP3/WAV/M4A, looping music. */
function makeFixture(opts: { musicDuck?: boolean; musicLoop?: boolean } = {}): AudioFixture {
  const dir = mkdtempSync(join(tmpdir(), "tracereel-audio-"));
  mkdirSync(join(dir, "audio", "narration"), { recursive: true });
  mkdirSync(join(dir, "audio", "music"), { recursive: true });
  copyFileSync(join(fixtureFrames, "01-post.png"), join(dir, "a.png"));
  copyFileSync(join(fixtureFrames, "02-liked.png"), join(dir, "b.png"));
  copyFileSync(join(fixtureFrames, "03-menu.png"), join(dir, "c.png"));
  tone(join(dir, "audio", "narration", "intro.mp3"), 2, 440);
  tone(join(dir, "audio", "narration", "booking.wav"), 1.5, 550);
  tone(join(dir, "audio", "narration", "confirm.m4a"), 2.5, 660);
  tone(join(dir, "audio", "music", "background.m4a"), 30, 110);

  const trace: TraceReelTrace = {
    version: 1,
    source: { type: "agent-browser", agent: "muse", session: "main" },
    viewport: { width: 1280, height: 800 },
    states: [
      { id: "intro", screenshot: "a.png", holdMs: 5000 },
      { id: "booking", screenshot: "b.png", holdMs: 6000 },
      { id: "confirm", screenshot: "c.png", holdMs: 6000 },
    ],
    actions: [],
    narration: [
      { state: "intro", text: "Welcome to the demo.", audio: "audio/narration/intro.mp3",
        generatedBy: { agent: "muse", tool: "tts", provider: "meta-ai" } },
      { state: "booking", text: "Now book your slot.", audio: "audio/narration/booking.wav" },
      { state: "confirm", text: "Confirm the details.", audio: "audio/narration/confirm.m4a" },
    ],
    audio: {
      music: {
        file: "audio/music/background.m4a",
        volume: 0.1,
        loop: opts.musicLoop ?? true,
        fadeInMs: 800,
        fadeOutMs: 1200,
        duckUnderNarration: opts.musicDuck ?? true,
      },
    },
  };
  const input = traceToReconstructionInput(trace);
  const manifest = buildReconstructionManifest(input, resolveConfig(RECONSTRUCTION_DEFAULTS, undefined));
  return { dir, trace, manifest };
}

test("narration clips start at their state's output-timeline time", () => {
  const { dir, trace, manifest } = makeFixture();
  const plan = planAudio(trace, manifest, { baseDir: dir });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.narration.length, 3);
  // State-based placement: clip i starts when frame i starts on the OUTPUT timeline.
  for (let i = 0; i < 3; i++) {
    assert.equal(plan.narration[i].startMs, Math.round(manifest.frames[i].t));
    assert.equal(plan.narration[i].explicitStart, false);
  }
  assert.deepEqual(
    plan.narration.map((p) => p.sceneStartMs),
    plan.narration.map((p) => p.startMs),
  );
});

test("mp3, wav and m4a narration inputs all probe", () => {
  const { dir } = makeFixture();
  const mp3 = probeAudioFile(join(dir, "audio", "narration", "intro.mp3"));
  const wav = probeAudioFile(join(dir, "audio", "narration", "booking.wav"));
  const m4a = probeAudioFile(join(dir, "audio", "narration", "confirm.m4a"));
  assert.equal(mp3.codec, "mp3");
  assert.ok(wav.codec.startsWith("pcm"));
  assert.equal(m4a.codec, "aac");
  for (const p of [mp3, wav, m4a]) {
    assert.ok(p.durationMs > 0);
    assert.ok(p.sampleRate > 0);
    assert.ok(p.channels > 0);
  }
  // Approximate durations of the generated tones.
  assert.ok(Math.abs(mp3.durationMs - 2000) < 120);
  assert.ok(Math.abs(wav.durationMs - 1500) < 120);
  assert.ok(Math.abs(m4a.durationMs - 2500) < 120);
});

test("explicit startMs overrides state-based placement", () => {
  const { dir, trace, manifest } = makeFixture();
  trace.narration![0].startMs = 1234;
  const plan = planAudio(trace, manifest, { baseDir: dir });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.narration[0].startMs, 1234);
  assert.equal(plan.narration[0].explicitStart, true);
});

test("music plan carries loop, volume, fades and ducking", () => {
  const { dir, trace, manifest } = makeFixture();
  const plan = planAudio(trace, manifest, { baseDir: dir });
  assert.equal(plan.errors.length, 0);
  const m = plan.music!;
  assert.equal(m.volume, 0.1);
  assert.equal(m.fadeInMs, 800);
  assert.equal(m.fadeOutMs, 1200);
  assert.equal(m.duckUnderNarration, true);
  assert.equal(m.targetDurationMs, Math.round(manifest.duration));
  // 30s music file vs ~17s video: no looping needed.
  assert.equal(m.loops, false);
});

test("music shorter than the video loops when loop=true", () => {
  const { dir, trace, manifest } = makeFixture();
  tone(join(dir, "audio", "music", "short.m4a"), 3, 110);
  trace.audio!.music!.file = "audio/music/short.m4a";
  const plan = planAudio(trace, manifest, { baseDir: dir });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.music!.loops, true);
});

test("ducking adds sidechain compression to the filter graph, off by default", () => {
  const { dir, trace, manifest } = makeFixture({ musicDuck: true });
  const plan = planAudio(trace, manifest, { baseDir: dir });
  const spec = buildMixSpec(plan, dir);
  assert.ok(spec.filterComplex.includes("sidechaincompress"), "ducking filter present");

  const plain = makeFixture({ musicDuck: false });
  const plan2 = planAudio(plain.trace, plain.manifest, { baseDir: plain.dir });
  const spec2 = buildMixSpec(plan2, plain.dir);
  assert.ok(!spec2.filterComplex.includes("sidechaincompress"), "no ducking filter when disabled");
});

test("narration longer than its scene warns NARRATION_EXCEEDS_SCENE", () => {
  const { dir, trace, manifest } = makeFixture();
  // Scene "intro" is 5000ms; the clip is 2000ms — no warning baseline.
  let plan = planAudio(trace, manifest, { baseDir: dir });
  assert.ok(!plan.warnings.some((w) => w.code === "NARRATION_EXCEEDS_SCENE"));
  // Shrink the scene below the clip.
  trace.states![0].holdMs = 500;
  const manifest2 = buildReconstructionManifest(
    traceToReconstructionInput(trace), resolveConfig(RECONSTRUCTION_DEFAULTS, undefined));
  plan = planAudio(trace, manifest2, { baseDir: dir });
  const w = plan.warnings.find((x) => x.code === "NARRATION_EXCEEDS_SCENE");
  assert.ok(w, "expected NARRATION_EXCEEDS_SCENE");
  assert.equal(w!.detail!.state, "intro");
  assert.equal(w!.detail!.audioDurationMs, w!.detail!.audioDurationMs);
  assert.ok((w!.detail!.audioDurationMs as number) > (w!.detail!.sceneDurationMs as number));
  assert.ok(w!.suggestion && w!.suggestion.length > 0);
  // Warning, not error: the build may proceed.
  assert.equal(plan.errors.length, 0);
});

test("missing narration audio file is a structured error", () => {
  const { dir, trace, manifest } = makeFixture();
  trace.narration![1].audio = "audio/narration/does-not-exist.mp3";
  const plan = planAudio(trace, manifest, { baseDir: dir });
  const e = plan.errors.find((x) => x.code === "AUDIO_FILE_MISSING");
  assert.ok(e, "expected AUDIO_FILE_MISSING");
  assert.ok(e!.path!.includes("/narration/1/audio"));
});

test("audio path escaping the trace directory is rejected", () => {
  const { dir, trace, manifest } = makeFixture();
  trace.narration![0].audio = "../../etc/passwd";
  const plan = planAudio(trace, manifest, { baseDir: dir });
  assert.ok(plan.errors.some((x) => x.code === "AUDIO_PATH_OUTSIDE_BUNDLE"));
  assert.throws(() => resolveAudioPath(dir, "../outside.mp3"), /escapes the trace directory/);
});

test("negative startMs and invalid music volume are errors", () => {
  const { dir, trace, manifest } = makeFixture();
  trace.narration![0].startMs = -5;
  let plan = planAudio(trace, manifest, { baseDir: dir });
  assert.ok(plan.errors.some((x) => x.code === "NARRATION_NEGATIVE_START"));

  const f2 = makeFixture();
  f2.trace.audio!.music!.volume = 1.5;
  plan = planAudio(f2.trace, f2.manifest, { baseDir: f2.dir });
  assert.ok(plan.errors.some((x) => x.code === "MUSIC_INVALID_VOLUME"));
});

test("unknown state reference is a structured error", () => {
  const { dir, trace, manifest } = makeFixture();
  trace.narration![0].state = "nope";
  const plan = planAudio(trace, manifest, { baseDir: dir });
  assert.ok(plan.errors.some((x) => x.code === "NARRATION_UNKNOWN_STATE"));
});

test("mux produces AAC audio and leaves video frames bit-identical", () => {
  const { dir, trace, manifest } = makeFixture();
  const plan = planAudio(trace, manifest, { baseDir: dir });
  assert.equal(plan.errors.length, 0);
  // A small synthetic video stands in for `tracereel reconstruct` output,
  // sized to the manifest's own duration so the timelines agree.
  const silent = join(dir, "silent.mp4");
  const durS = (Math.round(manifest.duration) / 1000).toFixed(3);
  execFileSync(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${durS}:size=320x240:rate=15`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", silent], { stdio: "pipe" });
  const out = join(dir, "final.mp4");
  const res = muxAudio({ videoFile: silent, plan, baseDir: dir, outFile: out });
  assert.equal(res.videoCodec, "h264");
  assert.equal(res.audioCodec, "aac");
  assert.equal(res.audioSampleRate, 48000);
  assert.equal(res.audioChannels, 2);
  assert.deepEqual(videoFrameHashes(silent), videoFrameHashes(out));
});

test("music-only and narration-only plans mix", () => {
  const { dir, trace, manifest } = makeFixture();
  // Narration only.
  const t1 = structuredClone(trace);
  delete t1.audio;
  const p1 = planAudio(t1, manifest, { baseDir: dir });
  assert.equal(p1.errors.length, 0);
  assert.equal(p1.music, null);
  assert.ok(buildMixSpec(p1, dir).filterComplex.includes("[aout]"));
  // Music only.
  const t2 = structuredClone(trace);
  delete t2.narration;
  const p2 = planAudio(t2, manifest, { baseDir: dir });
  assert.equal(p2.errors.length, 0);
  assert.equal(p2.narration.length, 0);
  assert.ok(p2.music);
});

test("subtitles derive cue timing from narration placement", () => {
  const { dir, trace, manifest } = makeFixture();
  const plan = planAudio(trace, manifest, { baseDir: dir });
  const cues = cuesFromPlan(plan);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].startMs, plan.narration[0].startMs);
  assert.equal(cues[0].endMs, plan.narration[0].startMs + plan.narration[0].audioDurationMs);
  assert.equal(cues[0].text, "Welcome to the demo.");
  const srt = cuesToSrt(cues);
  assert.ok(srt.includes("00:00:00,000 --> 00:00:02,"));
  assert.ok(srt.includes("Welcome to the demo."));
  const vtt = cuesToVtt(cues);
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:00.000 --> 00:00:02."));
  // Clips without text produce no cues.
  const t2 = structuredClone(trace);
  delete t2.narration![0].text;
  const p2 = planAudio(t2, manifest, { baseDir: dir });
  assert.equal(cuesFromPlan(p2).length, 2);
});

test("audio QA reports concrete metrics, no subjective scores", () => {
  const { dir, trace, manifest } = makeFixture();
  const plan = planAudio(trace, manifest, { baseDir: dir });
  const report = qaAudio(plan);
  assert.equal(report.metrics.narrationClips, 3);
  assert.ok(report.metrics.narrationTotalMs > 0);
  assert.deepEqual(report.metrics.narrationOnsetsMs, plan.narration.map((p) => p.startMs));
  assert.equal(report.metrics.musicPresent, true);
  assert.equal(report.metrics.duckingEnabled, true);
  assert.equal(report.metrics.musicVolume, 0.1);
  assert.equal(report.metrics.finalCodec, null); // no finished file passed
});

test("trace without audio plans cleanly (backward compatibility)", () => {
  const { dir, trace, manifest } = makeFixture();
  delete trace.narration;
  delete trace.audio;
  const plan = planAudio(trace, manifest, { baseDir: dir });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.warnings.length, 0);
  assert.equal(plan.narration.length, 0);
  assert.equal(plan.music, null);
});

test("bundle round-trips narration and music into audio/", () => {
  const { dir, trace } = makeFixture();
  const bundleDir = join(dir, "demo.tracereel");
  writeBundle(bundleDir, trace, { framesSourceDir: dir, adapter: "generic" });
  const loaded = loadBundle(bundleDir);
  assert.equal(loaded.narrationFiles.length, 3);
  assert.equal(loaded.musicFiles.length, 1);
  assert.ok(loaded.trace.narration![0].audio.startsWith("audio/narration/"));
  assert.ok(loaded.trace.audio!.music!.file.startsWith("audio/music/"));
  // The bundled trace still plans without errors.
  const input = traceToReconstructionInput(loaded.trace);
  const manifest = buildReconstructionManifest(input, resolveConfig(RECONSTRUCTION_DEFAULTS, undefined));
  const plan = planAudio(loaded.trace, manifest, { baseDir: bundleDir });
  assert.equal(plan.errors.length, 0);
});
