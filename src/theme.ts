import type { ThinkingLevel } from "./types.js";

// ── Color Palette ────────────────────────────────────────────────────

/**
 * Central colour token dictionary for the entire infobar.
 *
 * All colours are hex strings consumed by the `ansi()` helper which converts
 * them to ANSI 24-bit true-colour escape sequences.  Grouping them here as
 * `as const` makes accidental typos a TypeScript compile error and provides a
 * single place to tweak the visual design.
 */
export const COLOR = {
  // ── Text ─────────────────────────────────────────────────────────
  /** Primary text on dark panels. */
  ink: "#f8fafc",
  /** Muted secondary text (countdown timers, units). */
  soft: "#cbd5e1",
  /** Dimmed text (separators, inactive labels). */
  dim: "#94a3b8",
  /** High-contrast dark text for use on bright accent backgrounds. */
  black: "#020617",

  // ── Panels ───────────────────────────────────────────────────────
  /** Base footer background. */
  panel: "#111827",
  /** Slightly lifted chip value background – provides subtle depth. */
  panelLift: "#1f2937",
  /** Soft panel used for the Codex chip in idle state. */
  panelSoft: "#334155",
  /** Thin rule / separator colour. */
  separator: "#1e293b",

  // ── Path ─────────────────────────────────────────────────────────
  /** Accent colour for the working-directory path chip. */
  path: "#38bdf8",

  // ── Model ────────────────────────────────────────────────────────
  /** Accent colour for the MODEL chip. */
  model: "#60a5fa",

  // ── Context Usage ─────────────────────────────────────────────────
  /** Used when context percentage is unavailable (blends into panel). */
  contextTransparent: "#1f2937",
  /** 0–10 %: plenty of space remaining. */
  contextGreen: "#22c55e",
  /** 10–25 %: still comfortable. */
  contextLightGreen: "#86efac",
  /** 25–40 %: approaching mid-range. */
  contextLightYellow: "#fde68a",
  /** 40–55 %: context half full. */
  contextYellow: "#eab308",
  /** 55–70 %: getting tight, consider compacting. */
  contextOrange: "#f97316",
  /** 70–85 %: high utilisation warning. */
  contextLightRed: "#f87171",
  /** 85–100 %: near or at limit. */
  contextRed: "#ef4444",
  /** Alias used for the Codex "loading" accent. */
  contextWarn: "#f97316",
  /** Alias used for the Codex "error" accent. */
  contextFull: "#ef4444",

  // ── Thinking Level ───────────────────────────────────────────────
  /** Thinking disabled. */
  thinkOff: "#64748b",
  /** Minimal thinking budget. */
  thinkMinimal: "#22d3ee",
  /** Low thinking budget. */
  thinkLow: "#bbf7d0",
  /** Medium thinking budget. */
  thinkMedium: "#22c55e",
  /** High thinking budget. */
  thinkHigh: "#f97316",
  /** Extended (x-high) thinking budget. */
  thinkXhigh: "#dc46dc",
  /** Maximum thinking budget. */
  thinkMax: "#f43f5e",

  // ── Codex / OpenAI ───────────────────────────────────────────────
  /** Active OpenAI Codex chip accent. */
  openAi: "#60a5fa",
  /** Inactive / non-Codex model chip colour (muted grey). */
  openAiInactive: "#6c7074",

  // ── Git ──────────────────────────────────────────────────────────
  /** Branch name and staged-change indicator colour. */
  git: "#22c55e",
  /** Dirty-state indicator colour (unused directly but available for consumers). */
  gitDirty: "#f59e0b",
  /** Working-tree modification indicator (`~`). */
  gitModified: "#38bdf8",
  /** Untracked-file indicator (`✘`). */
  gitUntracked: "#ef4444",
  /** Staged-change and ahead-of-remote indicators (`+`, `⇡`). */
  gitStaged: "#22c55e",
  /** Deleted-file and behind-remote indicators (`-`, `⇣`). */
  gitDeleted: "#ef4444",
  /** Renamed/copied-file indicator (`»`). */
  gitRenamed: "#a78bfa",

  // ── Usage ────────────────────────────────────────────────────────
  /** Token count chip colour (input ↑ / output ↓). */
  token: "#64748b",
  /** Cost chip accent colour ($). */
  cost: "#15803d",
} as const;

// ── Color Resolvers ──────────────────────────────────────────────────

/**
 * Map a context-window usage percentage to a colour token.
 *
 * The scale runs from green (plenty of space) through yellow and orange to
 * red (near or over the limit).  Thresholds are intentionally graduated so
 * there is a gentle visual ramp rather than a sudden colour jump.
 *
 * @param percent  Context usage in [0, 100].
 */
export function contextColor(percent: number): string {
  if (percent < 10) return COLOR.contextGreen;
  if (percent < 25) return COLOR.contextLightGreen;
  if (percent < 40) return COLOR.contextLightYellow;
  if (percent < 55) return COLOR.contextYellow;
  if (percent < 70) return COLOR.contextOrange;
  if (percent < 85) return COLOR.contextLightRed;
  return COLOR.contextRed;
}

/**
 * Map a thinking level to its corresponding accent colour for the THINK chip.
 * Higher budgets use warmer / more vivid colours to convey cost intensity.
 */
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
    case "max":
      return COLOR.thinkMax;
  }

  // The extension may be loaded by a newer Pi host with a thinking level that
  // this version does not know yet. Never pass an undefined accent to the ANSI
  // renderer; reuse the highest known color until explicit support is added.
  return COLOR.thinkMax;
}

/**
 * Derive the accent colour for the Codex usage chip from the manager state
 * and whether a Codex model is currently active.
 *
 * @param state   Current CodexUsageManager state.
 * @param active  `true` when the selected model is an OpenAI Codex model.
 *                When `false`, a muted inactive colour is always returned
 *                regardless of state.
 */
export function codexAccent(
  state: import("./codex-usage/index.js").CodexUsageState,
  active = true,
): string {
  if (!active) return COLOR.openAiInactive;

  switch (state) {
    case "idle":
      return COLOR.panelSoft;   // blends into panel – chip is nearly invisible
    case "loading":
      return COLOR.contextWarn; // amber pulse draws attention while fetching
    case "error":
      return COLOR.contextFull; // red signals a problem requiring user action
    case "loaded":
      return COLOR.openAi;      // blue accent: data is fresh and reliable
  }
}

/**
 * Map the *remaining* capacity of a Codex rate-limit window to a colour.
 *
 * Note: the input is *remaining* (100 − usedPercent), so 0 % remaining is red
 * and 100 % remaining is green – the inverse of the context-usage scale.
 *
 * @param percent  Remaining capacity in [0, 100].
 */
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
