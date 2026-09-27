/**
 * What each known agent's captures are believed to provide.
 *
 * Only Muse is verified end to end. Grokbot's row is the expected shape for a
 * managed-browser agent; it must be re-checked against a real Grokbot capture
 * before being marked verified. The generic row is deliberately conservative.
 */
import type { AgentCapabilities } from "./trace/types.js";

export const MUSE_CAPABILITIES: AgentCapabilities = {
  screenshots: true,
  clickCoordinates: true,
  typingCoordinates: true,
  scrollEvents: true,
  hoverEvents: true,
  videoSegments: false,
  cursorFreeScreenshots: false,
};

export const GROKBOT_CAPABILITIES: AgentCapabilities = {
  screenshots: true,
  clickCoordinates: true,
  typingCoordinates: true,
  scrollEvents: true,
  hoverEvents: true,
  videoSegments: false,
  cursorFreeScreenshots: false,
};

export const GENERIC_CAPABILITIES: AgentCapabilities = {
  screenshots: true,
  clickCoordinates: false,
  typingCoordinates: false,
  scrollEvents: false,
  hoverEvents: false,
  videoSegments: false,
  cursorFreeScreenshots: false,
};

export const CAPABILITY_DESCRIPTIONS: Record<keyof AgentCapabilities, string> = {
  screenshots: "real screenshots, one per state",
  clickCoordinates: "click targets as viewport coordinates",
  typingCoordinates: "typing targets as viewport coordinates",
  scrollEvents: "scroll gestures with deltas",
  hoverEvents: "hover positions",
  videoSegments: "short real-motion clips (roadmap)",
  cursorFreeScreenshots: "screenshots captured without the OS cursor baked in",
};
