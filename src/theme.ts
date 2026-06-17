import type { ThinkingLevel } from "./types.js";

// ── Color Palette ────────────────────────────────────────────────────

export const COLOR = {
  // Text
  ink: "#f8fafc",
  soft: "#cbd5e1",
  dim: "#94a3b8",
  black: "#020617",

  // Panels
  panel: "#111827",
  panelLift: "#1f2937",
  panelSoft: "#334155",
  separator: "#1e293b",

  // Path
  path: "#38bdf8",

  // Model
  model: "#60a5fa",

  // Context usage
  contextTransparent: "#1f2937",
  contextGreen: "#22c55e",
  contextLightGreen: "#86efac",
  contextLightYellow: "#fde68a",
  contextYellow: "#eab308",
  contextOrange: "#f97316",
  contextLightRed: "#f87171",
  contextRed: "#ef4444",
  contextWarn: "#f97316",
  contextFull: "#ef4444",

  // Thinking level
  thinkOff: "#64748b",
  thinkMinimal: "#22d3ee",
  thinkLow: "#bbf7d0",
  thinkMedium: "#22c55e",
  thinkHigh: "#f97316",
  thinkXhigh: "#dc46dc",

  // Codex
  // openAi: "#009eb9",
  openAi: "#60a5fa",
  openAiInactive: "#6c7074",

  // Git
  git: "#22c55e",
  gitDirty: "#f59e0b",
  gitModified: "#38bdf8",
  gitUntracked: "#ef4444",
  gitStaged: "#22c55e",
  gitDeleted: "#ef4444",
  gitRenamed: "#a78bfa",

  // Usage
  token: "#64748b",
  cost: "#15803d",
} as const;

// ── Color Resolvers ──────────────────────────────────────────────────

export function contextColor(percent: number): string {
  if (percent < 10) return COLOR.contextGreen;
  if (percent < 25) return COLOR.contextLightGreen;
  if (percent < 40) return COLOR.contextLightYellow;
  if (percent < 55) return COLOR.contextYellow;
  if (percent < 70) return COLOR.contextOrange;
  if (percent < 85) return COLOR.contextLightRed;
  return COLOR.contextRed;
}

export function thinkingColor(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return COLOR.thinkOff;
    case "minimal":
      return COLOR.thinkMinimal;
    case "low":
      return COLOR.thinkLow;
    case "medium":
      return COLOR.thinkMedium;
    case "high":
      return COLOR.thinkHigh;
    case "xhigh":
      return COLOR.thinkXhigh;
  }
}

export function codexAccent(
  state: import("./codex-usage/index.js").CodexUsageState,
  active = true,
): string {
  if (!active) return COLOR.openAiInactive;

  switch (state) {
    case "idle":
      return COLOR.panelSoft;
    case "loading":
      return COLOR.contextWarn;
    case "error":
      return COLOR.contextFull;
    case "loaded":
      return COLOR.openAi;
  }
}

export function codexPercentColor(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped <= 10) return COLOR.contextRed;
  if (clamped <= 25) return COLOR.contextLightRed;
  if (clamped <= 40) return COLOR.contextOrange;
  if (clamped <= 55) return COLOR.contextYellow;
  if (clamped <= 70) return COLOR.contextLightYellow;
  if (clamped <= 85) return COLOR.contextLightGreen;
  return COLOR.contextGreen;
}
