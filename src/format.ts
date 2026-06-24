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
import type { ThinkingLevel, TokenTotals } from "./types.js";
import { COLOR, codexAccent, codexPercentColor, contextColor } from "./theme.js";

// ── Context ──────────────────────────────────────────────────────────

export function contextSnapshot(ctx: ExtensionContext): { label: string; color: string } {
  const usage = ctx.getContextUsage();
  const percent = typeof usage?.percent === "number" ? usage.percent : undefined;
  if (percent === undefined) return { label: "?", color: COLOR.contextTransparent };

  const clamped = Math.max(0, Math.min(100, percent));
  return { label: `${clamped.toFixed(0)}%`, color: contextColor(clamped) };
}

// ── Model ────────────────────────────────────────────────────────────

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
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatCost(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(3);
}

// ── Codex Status ─────────────────────────────────────────────────────

export interface CodexChipData {
	text: string;
	segments: Array<{ text: string; fg: string; bold?: boolean }>;
	accent: string;
}

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
				{ text: "usage unavailable", fg: active ? COLOR.soft : COLOR.openAiInactive },
			],
			accent,
		};
	}

	const parts: Array<{ text: string; fg: string; bold?: boolean }> = [];
	const textParts: string[] = [];

	const prefix = formatStatuslinePrefix(snapshot);
	if (prefix !== "codex") {
		parts.push({ text: prefix, fg: active ? COLOR.soft : COLOR.openAiInactive });
		textParts.push(prefix);
	}

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
	if (parts.length === 0 && snapshot.credits) {
		const creditsText = formatCredits(snapshot.credits);
		parts.push({ text: creditsText, fg: active ? COLOR.soft : COLOR.openAiInactive });
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

function formatStatuslinePrefix(snapshot: import("./codex-usage/types.js").NormalizedRateLimitSnapshot): string {
	if (isPrimaryCodexSnapshot(snapshot)) return "codex";
	const label = snapshot.limitName ?? snapshot.limitId;
	return `codex ${compactLimitLabel(label)}`;
}

function compactLimitLabel(label: string): string {
	const normalized = label.replace(/[_-]+/g, " ").trim();
	const codexVariant = normalized.match(/\bcodex\s+(.+)$/i)?.[1]?.trim();
	const compact = codexVariant || normalized;
	return compact.toLowerCase().replace(/\s+/g, " ");
}

function isPrimaryCodexSnapshot(snapshot: import("./codex-usage/types.js").NormalizedRateLimitSnapshot): boolean {
	return (
		normalizedUsageKey(snapshot.limitId) === "codex" ||
		normalizedUsageKey(snapshot.limitName) === "codex"
	);
}

function normalizedUsageKey(value: string | undefined): string | undefined {
	const key = value
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return key || undefined;
}

function formatRemainingPercent(window: import("./codex-usage/types.js").NormalizedRateLimitWindow): string {
	return `${(100 - clampPercent(window.usedPercent)).toFixed(0)}%`;
}

function formatResetCountdown(
	window: import("./codex-usage/types.js").NormalizedRateLimitWindow,
	fallback: string,
): string {
	if (typeof window.resetsAt !== "number" || !Number.isFinite(window.resetsAt)) {
		return fallback;
	}

	const remainingMs = window.resetsAt * 1000 - Date.now();
	if (!Number.isFinite(remainingMs)) return fallback;
	if (remainingMs <= 0) return "now";

	const minuteMs = 60 * 1000;
	const hourMs = 60 * minuteMs;
	const dayMs = 24 * hourMs;
	const windowMs = typeof window.windowMinutes === "number" ? window.windowMinutes * minuteMs : undefined;
	const isLongWindow = windowMs !== undefined ? windowMs > dayMs : fallback === "wk";

	if (remainingMs < hourMs) return `${Math.max(1, Math.ceil(remainingMs / minuteMs))}m`;
	if (isLongWindow && remainingMs < dayMs) return `${Math.ceil(remainingMs / hourMs)}h`;
	if (isLongWindow) return `${Math.ceil(remainingMs / dayMs)}d`;
	return `${Math.ceil(remainingMs / hourMs)}h`;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

// ── Paths ────────────────────────────────────────────────────────────

export function formatWorkingPath(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
	return cwd;
}

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

export function shorten(value: string, maxWidth: number): string {
	return truncateToWidth(value, maxWidth, "…");
}
