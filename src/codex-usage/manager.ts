import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
	CodexUsageModel,
	CodexUsageReport,
	NormalizedCredits,
	NormalizedRateLimitSnapshot,
	NormalizedRateLimitWindow,
	UsageQueryError,
} from "./types.js";
import { isOpenAICodexModel, queryUsage } from "./query.js";

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_SETTINGS_URL = "https://chatgpt.com/codex/settings/usage";
const BAR_SEGMENTS = 20;
const LIMIT_VALUE_COLUMN = 29;
const RESET_FOREGROUND = "\x1b[39m";

// ── Manager State ────────────────────────────────────────────────────

export type CodexUsageState = "idle" | "loading" | "loaded" | "error";

interface CachedReport {
	createdAt: number;
	report: CodexUsageReport;
}

// ── Query Options ────────────────────────────────────────────────────

export interface CodexStatusOptions {
	clearStatusline: boolean;
	refresh: boolean;
	statusline: boolean;
	timeoutMs: number;
}

interface CodexRefreshOptions {
	showErrors?: boolean;
}

// ── Manager ──────────────────────────────────────────────────────────

export class CodexUsageManager {
	private cache: CachedReport | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private requestId = 0;
	private _state: CodexUsageState = "idle";
	private onRender?: () => void;

	/** Current state: idle, loading, loaded, or error. */
	get state(): CodexUsageState {
		return this._state;
	}

	/** Latest cached report, or undefined if usage has not been fetched. */
	getReport(): CodexUsageReport | undefined {
		return this.cache?.report;
	}

	/** Whether the cache is still fresh. */
	isCacheFresh(): boolean {
		return this.cache !== undefined && Date.now() - this.cache.createdAt < CACHE_TTL_MS;
	}

	/** Bind the render callback. Called from the extension entry point. */
	setRenderCallback(onRender: (() => void) | undefined): void {
		this.onRender = onRender;
	}

	/** Cache a freshly queried report without issuing a second usage request. */
	setReport(report: CodexUsageReport, ctx?: ExtensionContext): void {
		this.requestId++;
		this.cache = { createdAt: Date.now(), report };
		this._state = "loaded";
		if (ctx) this.scheduleRefresh(ctx);
		else this.clearTimer();
		this.onRender?.();
	}

	/**
	 * Refresh Codex usage data when auth is available.
	 * - If cache is fresh and `force` is false, schedules next refresh only.
	 * - If no Codex auth is available and `showErrors` is false, returns to idle.
	 * - Otherwise fetches fresh data and caches it for any selected model.
	 */
	async refresh(
		ctx: ExtensionContext,
		force: boolean,
		model: CodexUsageModel | undefined = ctx.model,
		options: CodexRefreshOptions = {},
	): Promise<void> {
		const requestId = ++this.requestId;

		if (this.isCacheFresh() && !force) {
			this.scheduleRefresh(ctx);
			this._state = "loaded";
			this.onRender?.();
			return;
		}

		if (!this.cache) {
			this._state = "loading";
			this.onRender?.();
		}

		const result = await queryUsage(ctx, { timeoutMs: DEFAULT_TIMEOUT_MS });

		// Stale request guard
		if (requestId !== this.requestId) return;

		if (!result.ok) {
			const showErrors = options.showErrors ?? isOpenAICodexModel(model);
			this._state = showErrors ? "error" : this.cache ? "loaded" : "idle";
			if (showErrors || this.cache) this.scheduleRefresh(ctx);
			else this.clearTimer();
			this.onRender?.();
			return;
		}

		this.cache = { createdAt: Date.now(), report: result.report };
		this._state = "loaded";
		this.scheduleRefresh(ctx);
		this.onRender?.();
	}

	/** Clear all state (statusline disabled or session shutdown). */
	clear(): void {
		this.requestId++;
		this.clearTimer();
		this.cache = undefined;
		this._state = "idle";
		this.onRender?.();
	}

	/** Dispose all timers. */
	dispose(): void {
		this.clearTimer();
		this.onRender = undefined;
	}

	private scheduleRefresh(ctx: ExtensionContext): void {
		this.clearTimer();
		this.refreshTimer = setTimeout(() => {
			void this.refresh(ctx, true);
		}, CACHE_TTL_MS);
		this.refreshTimer.unref?.();
	}

	private clearTimer(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}
}

// ── Command Argument Parsing ─────────────────────────────────────────

export function parseCodexStatusArgs(
	args: string,
): { ok: true; value: CodexStatusOptions } | { ok: false; error: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let clearStatusline = false;
	let refresh = false;
	let statusline = true;
	let timeoutMs = DEFAULT_TIMEOUT_MS;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--clear-statusline") {
			clearStatusline = true;
			continue;
		}
		if (token === "--no-statusline") {
			statusline = false;
			continue;
		}
		if (token === "--refresh") {
			refresh = true;
			continue;
		}
		if (token === "--timeout") {
			const rawValue = tokens[index + 1];
			if (!rawValue)
				return {
					ok: false,
					error: "Usage: /codex-status [--refresh] [--timeout seconds]",
				};
			const parsed = Number(rawValue);
			if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 120) {
				return {
					ok: false,
					error: "--timeout must be a number of seconds between 1 and 120.",
				};
			}
			timeoutMs = Math.round(parsed * 1000);
			index += 1;
			continue;
		}
		return {
			ok: false,
			error: `Unknown option: ${token}. Usage: /codex-status [--refresh] [--no-statusline] [--clear-statusline] [--timeout seconds]`,
		};
	}

	return { ok: true, value: { clearStatusline, refresh, statusline, timeoutMs } };
}

// ── Report Formatting (for /codex-status notification) ───────────────

export function formatCodexUsageReport(report: CodexUsageReport): string {
	const lines = [
		"  >_ OpenAI Codex Usage",
		"",
		`Visit ${USAGE_SETTINGS_URL} for up-to-date`,
		"information on rate limits and credits",
		"",
	];

	for (const snapshot of report.snapshots) {
		const label = snapshot.limitName ?? snapshot.limitId;
		if (!isPrimaryCodexSnapshot(snapshot)) {
			lines.push(`  ${label} limit:`);
		}
		if (snapshot.primary) lines.push(formatWindowLine("5h limit:", snapshot.primary));
		if (snapshot.secondary) lines.push(formatWindowLine("Weekly limit:", snapshot.secondary));
		if (!snapshot.primary && !snapshot.secondary) {
			lines.push("  Limits unavailable for this account");
		}
	}

	return lines.join("\n");
}

export function showCodexReport(
	ctx: ExtensionCommandContext,
	report: CodexUsageReport,
	fromCache: boolean,
): void {
	const text = formatCodexUsageReport(report);
	ctx.ui.notify(ctx.hasUI ? `${RESET_FOREGROUND}${text}` : text, "info");
}

export function formatQueryErrors(errors: UsageQueryError[]): string {
	const lines = ["Unable to read Codex usage."];
	for (const error of errors) {
		const source =
			error.source === "pi-auth" ? "Pi auth direct" : "Codex app-server fallback";
		lines.push(`- ${source}: ${error.message}`);
	}
	lines.push("");
	lines.push(
		"Tip: use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro. If Pi auth is unavailable, install Codex CLI and run codex login for the fallback.",
	);
	return lines.join("\n");
}

// ── Snapshot Selection ───────────────────────────────────────────────

export function selectSnapshotForModel(
	report: CodexUsageReport,
	model: CodexUsageModel | undefined,
): NormalizedRateLimitSnapshot | undefined {
	const codexSnapshot = report.snapshots.find(isPrimaryCodexSnapshot);
	if (!model || !isOpenAICodexModel(model)) return codexSnapshot ?? report.snapshots[0];

	const modelKeys = normalizedModelUsageKeys(model);
	const exactMatch = report.snapshots.find((snapshot) =>
		normalizedSnapshotUsageKeys(snapshot).some((key) => modelKeys.has(key)),
	);
	if (exactMatch) return exactMatch;

	const variants = codexModelVariantKeys(modelKeys);
	for (const variant of variants) {
		const matches = report.snapshots.filter(
			(snapshot) =>
				!isPrimaryCodexSnapshot(snapshot) &&
				normalizedSnapshotUsageKeys(snapshot).some((key) =>
					normalizedKeyHasToken(key, variant),
				),
		);
		if (matches.length === 1) return matches[0];
	}

	return codexSnapshot ?? report.snapshots[0];
}

// ── Internal Formatting Helpers ──────────────────────────────────────

function isPrimaryCodexSnapshot(snapshot: NormalizedRateLimitSnapshot): boolean {
	return (
		normalizedUsageKey(snapshot.limitId) === "codex" ||
		normalizedUsageKey(snapshot.limitName) === "codex"
	);
}

function formatWindowLine(label: string, window: NormalizedRateLimitWindow): string {
	return `  ${label.padEnd(LIMIT_VALUE_COLUMN)}${formatWindow(window)}`;
}

function formatWindow(window: NormalizedRateLimitWindow): string {
	const remaining = 100 - clampPercent(window.usedPercent);
	const reset = window.resetsAt ? ` (resets ${formatReset(window.resetsAt)})` : "";
	return `${progressBar(remaining)} ${remaining.toFixed(0)}% left${reset}`;
}

function progressBar(percentRemaining: number): string {
	const filled = Math.round((clampPercent(percentRemaining) / 100) * BAR_SEGMENTS);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

export function formatCredits(credits: NormalizedCredits): string {
	if (!credits.hasCredits) return "no credits";
	if (credits.unlimited) return "unlimited credits";
	const balance = credits.balance?.trim();
	if (!balance) return "credits available";
	return `${formatNumber(Number(balance), balance)} credits`;
}

function formatReset(epochSeconds: number): string {
	const reset = new Date(epochSeconds * 1000);
	if (Number.isNaN(reset.getTime())) return "at an unknown time";

	const now = new Date();
	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	if (reset.toDateString() === now.toDateString()) return time;
	const day = reset.getDate().toString();
	const month = reset.toLocaleDateString(undefined, { month: "short" });
	return `${time} on ${day} ${month}`;
}

function formatNumber(value: number, fallback: string): string {
	if (!Number.isFinite(value)) return fallback;
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

// ── Snapshot Key Matching ────────────────────────────────────────────

function normalizedModelUsageKeys(model: CodexUsageModel): Set<string> {
	const keys = new Set<string>();
	addNormalizedUsageKey(keys, model.id);
	addNormalizedUsageKey(keys, model.name);

	for (const key of [...keys]) {
		const codexIndex = key.indexOf("codex");
		if (codexIndex >= 0) keys.add(key.slice(codexIndex));
	}

	return keys;
}

function normalizedSnapshotUsageKeys(snapshot: NormalizedRateLimitSnapshot): string[] {
	return [normalizedUsageKey(snapshot.limitId), normalizedUsageKey(snapshot.limitName)].filter(
		(key): key is string => key !== undefined,
	);
}

function addNormalizedUsageKey(keys: Set<string>, value: string | undefined): void {
	const key = normalizedUsageKey(value);
	if (key) keys.add(key);
}

function normalizedUsageKey(value: string | undefined): string | undefined {
	const key = value
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return key || undefined;
}

function codexModelVariantKeys(modelKeys: Set<string>): string[] {
	const variants = new Set<string>();
	for (const key of modelKeys) {
		const match = key.match(/(?:^|-)codex-(.+)$/);
		if (match?.[1]) variants.add(match[1]);
	}
	return [...variants];
}

function normalizedKeyHasToken(key: string, token: string): boolean {
	return (
		key === token ||
		key.startsWith(`${token}-`) ||
		key.endsWith(`-${token}`) ||
		key.includes(`-${token}-`)
	);
}
