import { homedir } from "node:os";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type {
	CodexUsageModel,
	CodexUsageReport,
	CodexUsageState,
} from "./codex-usage/index.js";
import { formatCredits, selectSnapshotForModel } from "./codex-usage/index.js";
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
	if (state === "loading") {
		return {
			text: "checking",
			segments: [{ text: "checking", fg: COLOR.soft }],
			accent: codexAccent(state),
		};
	}

	if (state === "error" || !report) {
		const label = state === "error" ? "usage error" : "usage —";
		return {
			text: label,
			segments: [{ text: label, fg: COLOR.soft }],
			accent: codexAccent(state),
		};
	}

	const snapshot = selectSnapshotForModel(report, model);
	if (!snapshot) {
		return {
			text: "usage unavailable",
			segments: [{ text: "usage unavailable", fg: COLOR.soft }],
			accent: codexAccent("loaded"),
		};
	}

	const parts: Array<{ text: string; fg: string; bold?: boolean }> = [];
	const textParts: string[] = [];

	const prefix = formatStatuslinePrefix(snapshot);
	if (prefix !== "codex") {
		parts.push({ text: prefix, fg: COLOR.soft });
		textParts.push(prefix);
	}

	if (snapshot.primary) {
		const pct = formatRemainingPercent(snapshot.primary);
		parts.push(
			{ text: pct, fg: codexPercentColor(100 - clampPercent(snapshot.primary.usedPercent)), bold: true },
			{ text: "5h", fg: COLOR.dim },
		);
		textParts.push(`${pct} 5h`);
	}
	if (snapshot.secondary) {
		const pct = formatRemainingPercent(snapshot.secondary);
		parts.push(
			{ text: pct, fg: codexPercentColor(100 - clampPercent(snapshot.secondary.usedPercent)), bold: true },
			{ text: "wk", fg: COLOR.dim },
		);
		textParts.push(`${pct} wk`);
	}
	if (parts.length === 0 && snapshot.credits) {
		const creditsText = formatCredits(snapshot.credits);
		parts.push({ text: creditsText, fg: COLOR.soft });
		textParts.push(creditsText);
	}

	if (parts.length === 0) {
		return {
			text: "usage —",
			segments: [{ text: "usage —", fg: COLOR.soft }],
			accent: codexAccent("loaded"),
		};
	}

	return {
		text: textParts.join(" "),
		segments: parts,
		accent: codexAccent("loaded"),
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
