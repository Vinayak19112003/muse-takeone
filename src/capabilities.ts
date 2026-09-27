/**
 * What each known agent's captures are believed to provide.
 *
 * Only Muse is verified end to end. Grokbot's row is the expected shape for a
 * managed-browser agent; it must be re-checked against a real Grokbot capture
 * before being marked verified. The generic row is deliberately conservative.
 */
import type { AgentCapabilities } from "./trace/types.js";
import { existsSync } from "node:fs";

/**
 * Whether Muse's TTS/voice skill is actually present in this environment.
 * narrationAudioGeneration is only ever claimed when the tool really exists —
 * TraceReel itself never provides TTS.
 */
export function museTtsAvailable(): boolean {
  const candidates = [
    "/opt/hatch/skills/tts/SKILL.md",
    process.env.HOME ? `${process.env.HOME}/workspace/skills/tts/SKILL.md` : "",
  ];
  return candidates.some((p) => p && existsSync(p));
}

export const MUSE_CAPABILITIES: AgentCapabilities = {
  screenshots: true,
  clickCoordinates: true,
  typingCoordinates: true,
  scrollEvents: true,
  hoverEvents: true,
  videoSegments: false,
  cursorFreeScreenshots: false,
  narrationAudioGeneration: museTtsAvailable(),
  browserAudio: false,
};

export const GROKBOT_CAPABILITIES: AgentCapabilities = {
  screenshots: true,
  clickCoordinates: true,
  typingCoordinates: true,
  scrollEvents: true,
  hoverEvents: true,
  videoSegments: false,
  cursorFreeScreenshots: false,
  // Not claimed until tested against a real Grokbot capture.
  narrationAudioGeneration: false,
  browserAudio: false,
};

export const GENERIC_CAPABILITIES: AgentCapabilities = {
  screenshots: true,
  clickCoordinates: false,
  typingCoordinates: false,
  scrollEvents: false,
  hoverEvents: false,
  videoSegments: false,
  cursorFreeScreenshots: false,
  narrationAudioGeneration: false,
  browserAudio: false,
};

export const CAPABILITY_DESCRIPTIONS: Record<keyof AgentCapabilities, string> = {
  screenshots: "real screenshots, one per state",
  clickCoordinates: "click targets as viewport coordinates",
  typingCoordinates: "typing targets as viewport coordinates",
  scrollEvents: "scroll gestures with deltas",
  hoverEvents: "hover positions",
  videoSegments: "short real-motion clips (roadmap)",
  cursorFreeScreenshots: "screenshots captured without the OS cursor baked in",
  narrationAudioGeneration: "agent can generate narration audio with its own TTS/voice tool (TraceReel never provides TTS)",
  browserAudio: "genuine captured browser/system audio (never synthesized)",
};
