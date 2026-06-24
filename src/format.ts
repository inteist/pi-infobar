import { homedir } from "node:os";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type {
  CodexUsageModel,
  CodexUsageReport,
  CodexUsageState,
} from "./codex-usage/index.js";
import {
  formatCredits,
  isOpenAICodexModel,
  selectSnapshotForModel,
} from "./codex-usage/index.js";
import {
  COLOR,
  codexAccent,
  codexPercentColor,
  contextColor,
} from "./theme.js";
import type { ThinkingLevel, TokenTotals } from "./types.js";

// ── Context ──────────────────────────────────────────────────────────

/**
 * Snapshot the current context-window utilization as a display label and
 * a color hint for the CTX chip.
 *
 * Returns `{ label: "?", color: contextTransparent }` when the usage data is
 * unavailable (e.g. model does not report token counts yet).
 */
export function contextSnapshot(ctx: ExtensionContext): {
  label: string;
  color: string;
} {
  const usage = ctx.getContextUsage();
  const percent =
    typeof usage?.percent === "number" ? usage.percent : undefined;
  if (percent === undefined)
    return { label: "?", color: COLOR.contextTransparent };

  // Clamp to [0, 100] defensively – the API could theoretically return >100%.
  const clamped = Math.max(0, Math.min(100, percent));
  return { label: `${clamped.toFixed(0)}%`, color: contextColor(clamped) };
}

// ── Model ────────────────────────────────────────────────────────────

/**
 * Return a display-ready model name for the MODEL chip.
 * Prefers the model's `id` over its `name` (ids are more stable identifiers).
 */
export function modelName(ctx: ExtensionContext): string {
  const model = ctx.model as { id?: string; name?: string } | undefined;
  return shortenModel(model?.id ?? model?.name ?? "no model");
}

/**
 * Shorten a raw model id/name to a compact chip-friendly label.
 *
 * Transformations applied in order:
 *  1. Strip the `claude-` vendor prefix.
 *  2. Convert `gpt-` to `gpt ` (space makes the remaining version number more readable).
 *  3. Strip date-stamp suffixes of the form `-20YYMMDD`.
 *  4. Strip the `-latest` alias suffix.
 *  5. Strip common quality/variant suffixes: `-instruct`, `-preview`, `-thinking`.
 *  6. Truncate to 28 visible characters with an ellipsis.
 */
export function shortenModel(model: string): string {
  return shorten(
    model
      .replace(/^claude-/, "")
      .replace(/^gpt-/, "gpt ")
      .replace(/-20\d{6}$/, "")
      .replace(/-latest$/, "")
      .replace(/-(instruct|preview|thinking)$/i, ""),
    28,
  );
}

// ── Thinking ─────────────────────────────────────────────────────────

/**
 * Convert a ThinkingLevel value to its display string.
 * The only transformation needed is normalising `"xhigh"` → `"x-high"` so
 * the chip label reads naturally.
 */
export function formatThinking(level: ThinkingLevel): string {
  if (level === "xhigh") return "x-high";
  return level;
}

// ── Tokens / Cost ────────────────────────────────────────────────────

/**
 * Aggregate input tokens, output tokens, and cost across all assistant
 * messages in the current session branch.
 *
 * Only `role === "assistant"` messages carry usage data; user and system
 * messages are skipped.  The branch is the linear path from the root to the
 * currently active leaf, so it represents the "active conversation" view
 * without counting pruned or alternate branches.
 */
export function getTokenTotals(ctx: ExtensionContext): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cost: 0 };

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      usage?: { input?: number; output?: number; cost?: { total?: number } };
    };
    if (message.role !== "assistant") continue;

    totals.input += message.usage?.input ?? 0;
    totals.output += message.usage?.output ?? 0;
    totals.cost += message.usage?.cost?.total ?? 0;
  }

  return totals;
}

/**
 * Format a raw token count as a short human-readable string.
 *
 * Thresholds:
 *  - < 1 000         → exact number        (e.g. "847")
 *  - 1 000 – 9 999   → one decimal place k  (e.g. "4.2k")
 *  - 10 000 – 999 999 → rounded k           (e.g. "58k")
 *  - ≥ 1 000 000     → one decimal place m  (e.g. "1.3m")
 */
export function formatCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000)
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/**
 * Format a USD cost value.
 * Values ≥ $1 are shown with 2 decimal places; sub-dollar amounts use 3 so
 * small fractions of a cent are still visible (e.g. "$0.003").
 */
export function formatCost(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(3);
}

// ── Codex Status ─────────────────────────────────────────────────────

/**
 * The data structure returned by `formatCodexChipData`, encapsulating both
 * a plain-text representation (`text`) for truncation measurements and a
 * list of coloured ANSI segments (`segments`) for the actual chip render.
 */
export interface CodexChipData {
  text: string;
  segments: Array<{ text: string; fg: string; bold?: boolean }>;
  accent: string;
}

/**
 * Derive all display data for the OpenAI Codex usage chip from the current
 * manager state and report.
 *
 * The function handles every possible manager state:
 *  - `loading` → "checking" placeholder with appropriate colour
 *  - `error` / no report → error or dash label
 *  - no matching snapshot for model → "usage unavailable"
 *  - normal → prefix + primary window (5h) + secondary window (weekly) + credits fallback
 *
 * The `active` flag (derived from `isOpenAICodexModel`) drives whether the
 * chip uses vivid active colours or muted inactive colours.
 */
export function formatCodexChipData(
  report: CodexUsageReport | undefined,
  state: CodexUsageState,
  model: CodexUsageModel | undefined,
): CodexChipData {
  const active = isOpenAICodexModel(model);
  const accent = codexAccent(state, active);

  if (state === "loading") {
    return {
      text: "checking",
      segments: [
        { text: "checking", fg: active ? COLOR.soft : COLOR.openAiInactive },
      ],
      accent,
    };
  }

  if (state === "error" || !report) {
    const label = state === "error" ? "usage error" : "usage —";
    return {
      text: label,
      segments: [
        { text: label, fg: active ? COLOR.soft : COLOR.openAiInactive },
      ],
      accent,
    };
  }

  const snapshot = selectSnapshotForModel(report, model);
  if (!snapshot) {
    return {
      text: "usage unavailable",
      segments: [
        {
          text: "usage unavailable",
          fg: active ? COLOR.soft : COLOR.openAiInactive,
        },
      ],
      accent,
    };
  }

  const parts: Array<{ text: string; fg: string; bold?: boolean }> = [];
  const textParts: string[] = [];

  // Prepend a limit-name prefix when the snapshot is not the primary "codex"
  // bucket (e.g. "codex mini" for a per-model sub-limit).
  const prefix = formatStatuslinePrefix(snapshot);
  if (prefix !== "codex") {
    parts.push({
      text: prefix,
      fg: active ? COLOR.soft : COLOR.openAiInactive,
    });
    textParts.push(prefix);
  }

  // Primary window (typically the 5-hour rolling window).
  if (snapshot.primary) {
    const pct = formatRemainingPercent(snapshot.primary);
    const reset = formatResetCountdown(snapshot.primary, "5h");
    const pctColor = active
      ? codexPercentColor(100 - clampPercent(snapshot.primary.usedPercent))
      : COLOR.openAiInactive;
    parts.push(
      { text: pct, fg: pctColor, bold: true },
      { text: reset, fg: active ? COLOR.dim : COLOR.openAiInactive },
    );
    textParts.push(`${pct} ${reset}`);
  }

  // Secondary window (typically the weekly rolling window).
  if (snapshot.secondary) {
    const pct = formatRemainingPercent(snapshot.secondary);
    const reset = formatResetCountdown(snapshot.secondary, "wk");
    const pctColor = active
      ? codexPercentColor(100 - clampPercent(snapshot.secondary.usedPercent))
      : COLOR.openAiInactive;
    parts.push(
      { text: pct, fg: pctColor, bold: true },
      { text: reset, fg: active ? COLOR.dim : COLOR.openAiInactive },
    );
    textParts.push(`${pct} ${reset}`);
  }

  // Fallback to credits when no rate-limit windows are present.
  if (parts.length === 0 && snapshot.credits) {
    const creditsText = formatCredits(snapshot.credits);
    parts.push({
      text: creditsText,
      fg: active ? COLOR.soft : COLOR.openAiInactive,
    });
    textParts.push(creditsText);
  }

  if (parts.length === 0) {
    return {
      text: "usage —",
      segments: [
        { text: "usage —", fg: active ? COLOR.soft : COLOR.openAiInactive },
      ],
      accent,
    };
  }

  return {
    text: textParts.join(" "),
    segments: parts,
    accent,
  };
}

/**
 * Build the prefix label shown before the usage numbers in the chip.
 * Returns `"codex"` for the primary bucket (callers omit the prefix to save
 * space) or `"codex <compact-label>"` for sub-limits.
 */
function formatStatuslinePrefix(
  snapshot: import("./codex-usage/types.js").NormalizedRateLimitSnapshot,
): string {
  if (isPrimaryCodexSnapshot(snapshot)) return "codex";
  const label = snapshot.limitName ?? snapshot.limitId;
  return `codex ${compactLimitLabel(label)}`;
}

/**
 * Compress a raw limit name into a short, lowercase, space-normalised label
 * suitable for display in the chip prefix.
 *
 * Steps:
 *  1. Replace runs of `_` and `-` with spaces.
 *  2. Extract the part after a leading `codex ` prefix (if any).
 *  3. Lower-case and collapse repeated spaces.
 */
function compactLimitLabel(label: string): string {
  const normalized = label.replace(/[_-]+/g, " ").trim();
  const codexVariant = normalized.match(/\bcodex\s+(.+)$/i)?.[1]?.trim();
  const compact = codexVariant || normalized;
  return compact.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Return `true` when the snapshot's `limitId` or `limitName` normalises to
 * the string `"codex"`, indicating the top-level Codex rate-limit bucket.
 */
function isPrimaryCodexSnapshot(
  snapshot: import("./codex-usage/types.js").NormalizedRateLimitSnapshot,
): boolean {
  return (
    normalizedUsageKey(snapshot.limitId) === "codex" ||
    normalizedUsageKey(snapshot.limitName) === "codex"
  );
}

/**
 * Normalise a string to a lowercase, hyphen-delimited identifier.
 * Returns `undefined` for empty or all-punctuation inputs.
 */
function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

/**
 * Format the remaining capacity of a rate-limit window as a percentage string.
 * E.g. `usedPercent = 30` → `"70%"`.
 */
function formatRemainingPercent(
  window: import("./codex-usage/types.js").NormalizedRateLimitWindow,
): string {
  return `${(100 - clampPercent(window.usedPercent)).toFixed(0)}%`;
}

/**
 * Format the time until a rate-limit window resets as a human-readable
 * countdown string (e.g. `"23m"`, `"4h"`, `"2d"`).
 *
 * Falls back to the `fallback` string (e.g. `"5h"` or `"wk"`) when the
 * `resetsAt` timestamp is missing or non-finite.
 *
 * The `isLongWindow` flag (derived from `windowMinutes` or the fallback hint)
 * controls whether hours beyond the first day are shown as hours or days.
 */
function formatResetCountdown(
  window: import("./codex-usage/types.js").NormalizedRateLimitWindow,
  fallback: string,
): string {
  if (
    typeof window.resetsAt !== "number" ||
    !Number.isFinite(window.resetsAt)
  ) {
    return fallback;
  }

  const remainingMs = window.resetsAt * 1000 - Date.now();
  if (!Number.isFinite(remainingMs)) return fallback;
  if (remainingMs <= 0) return "now";

  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const windowMs =
    typeof window.windowMinutes === "number"
      ? window.windowMinutes * minuteMs
      : undefined;
  // Treat windows longer than a day (e.g. weekly) as "long" so we switch
  // from hours to days once the reset is more than 24 h away.
  const isLongWindow =
    windowMs !== undefined ? windowMs > dayMs : fallback === "wk";

  if (remainingMs < hourMs)
    return `${Math.max(1, Math.ceil(remainingMs / minuteMs))}m`;
  if (isLongWindow && remainingMs < dayMs)
    return `${Math.ceil(remainingMs / hourMs)}h`;
  if (isLongWindow) return `${Math.ceil(remainingMs / dayMs)}d`;
  return `${Math.ceil(remainingMs / hourMs)}h`;
}

/** Clamp a percentage value to [0, 100], treating NaN/Infinity as 0. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

// ── Paths ────────────────────────────────────────────────────────────

/**
 * Replace the user's home directory prefix in `cwd` with `~` for display.
 * Returns `"~"` when `cwd` is exactly the home directory.
 */
export function formatWorkingPath(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
  return cwd;
}

/**
 * Truncate a file-system path to `maxWidth` visible characters in a way that
 * preserves the most useful context (the trailing two path components).
 *
 * Strategy:
 *  1. If the path already fits → return as-is.
 *  2. If there are ≥ 2 components and at least 12 columns available →
 *     render `…/<parent>/<basename>` and truncate that if still too wide.
 *  3. Otherwise → hard-truncate the full path.
 */
export function smartPathTruncate(path: string, maxWidth: number): string {
  if (visibleWidth(path) <= maxWidth) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2 && maxWidth >= 12) {
    const tail = parts.slice(-2).join("/");
    return truncateToWidth(`…/${tail}`, maxWidth, "…");
  }
  return truncateToWidth(path, maxWidth, "…");
}

// ── Shared Utilities ─────────────────────────────────────────────────

/**
 * Truncate `value` to `maxWidth` visible columns, appending an ellipsis if
 * truncation was necessary.  Delegates to the `@earendil-works/pi-tui` helper
 * so ANSI escape sequences are correctly handled.
 */
export function shorten(value: string, maxWidth: number): string {
  return truncateToWidth(value, maxWidth, "…");
}
