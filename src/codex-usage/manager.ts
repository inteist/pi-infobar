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

/** Maximum time to wait for a usage query before declaring it failed. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** How long a fetched usage report remains fresh before a background
 *  refresh is triggered.  5 minutes balances server load vs. staleness. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Initial delay before retrying a failed background refresh.
 *  Consecutive failures back off exponentially up to CACHE_TTL_MS. */
const REFRESH_RETRY_BASE_MS = 60 * 1000;

/** Deep-link to the usage settings page shown in the /codex-status report. */
const USAGE_SETTINGS_URL = "https://chatgpt.com/codex/settings/usage";

/** Number of block segments in the ASCII progress bar (e.g. [████░░░░░░]). */
const BAR_SEGMENTS = 20;

/** Column width reserved for the limit label in the formatted report,
 *  so that the bar and percentage values align across multiple rows. */
const LIMIT_VALUE_COLUMN = 29;

/** ANSI reset-foreground sequence prepended to TUI notifications so that the
 *  notification text is rendered with the terminal's default foreground colour
 *  rather than inheriting whatever colour the preceding chip used. */
const RESET_FOREGROUND = "\x1b[39m";

// ── Manager State ────────────────────────────────────────────────────

/** The four possible lifecycle states of CodexUsageManager:
 *  - `idle`    – no fetch has been attempted (infobar disabled or non-Codex model)
 *  - `loading` – a fetch is in progress and no prior data exists to show
 *  - `loaded`  – a report is cached and displayed in the footer
 *  - `error`   – the most recent fetch failed (shown with a red accent)
 */
export type CodexUsageState = "idle" | "loading" | "loaded" | "error";

/** Internal wrapper that tags a cached report with its fetch timestamp so
 *  we can compute remaining TTL for scheduling the next refresh. */
interface CachedReport {
	createdAt: number;
	report: CodexUsageReport;
}

// ── Query Options ────────────────────────────────────────────────────

/** Parsed options from the `/codex-status` command arguments. */
export interface CodexStatusOptions {
	/** When true, clear the cached report from the statusline. */
	clearStatusline: boolean;
	/** When true, bypass the cache and force a fresh network fetch. */
	refresh: boolean;
	/** When true (the default), store the fetched report in the statusline cache. */
	statusline: boolean;
	/** Request timeout in milliseconds. */
	timeoutMs: number;
}

/** Options forwarded to the internal refresh method. */
interface CodexRefreshOptions {
	/** Whether to flip the manager state to `error` on failure.
	 *  Typically `true` only when the active model is a Codex model. */
	showErrors?: boolean;
}

// ── Manager ──────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of OpenAI Codex usage data for the infobar.
 *
 * Responsibilities:
 *  - Fetch usage from the Pi auth endpoint (or the Codex app-server fallback).
 *  - Cache the report for CACHE_TTL_MS to avoid hammering the API.
 *  - Schedule automatic background refreshes after the cache expires.
 *  - Notify the TUI render loop whenever the state changes.
 *  - Guard against stale async responses via a monotonically-incrementing
 *    `requestId` generation counter.
 */
export class CodexUsageManager {
	/** The most recently cached report, or `undefined` if none has been fetched. */
	private cache: CachedReport | undefined;

	/** Handle for the background refresh timer so we can clear it on disposal. */
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Generation counter incremented on every state-invalidating action
	 * (new fetch, clear, setReport).  Async fetch callbacks compare their
	 * captured generation with the current value to detect staleness, preventing
	 * out-of-order responses from overwriting newer state.
	 */
	private requestId = 0;

	/** Number of consecutive failed refresh attempts, used for retry backoff. */
	private refreshFailures = 0;

	private _state: CodexUsageState = "idle";

	/** Callback invoked whenever the state or data changes so the TUI redraws. */
	private onRender?: () => void;

	/** Current state: idle, loading, loaded, or error. */
	get state(): CodexUsageState {
		return this._state;
	}

	/** Latest cached report, or undefined if usage has not been fetched. */
	getReport(): CodexUsageReport | undefined {
		return this.cache?.report;
	}

	/**
	 * Whether the cache is still within its TTL window.
	 * Used by the `/codex-status` command to skip a redundant network fetch
	 * when the user has not explicitly requested a refresh.
	 */
	isCacheFresh(): boolean {
		return this.cache !== undefined && Date.now() - this.cache.createdAt < CACHE_TTL_MS;
	}

	/**
	 * Bind the render callback that the TUI will invoke when it needs a fresh
	 * frame.  Pass `undefined` to detach (e.g. when the footer is torn down).
	 */
	setRenderCallback(onRender: (() => void) | undefined): void {
		this.onRender = onRender;
	}

	/**
	 * Store a report that was fetched externally (e.g. by the `/codex-status`
	 * command) without issuing a redundant second usage request.
	 *
	 * Schedules the next background refresh for when the new entry expires.
	 * If no context is provided the timer is cleared instead – useful when the
	 * caller doesn't want automatic refreshes (e.g. during a no-statusline fetch).
	 */
	setReport(report: CodexUsageReport, ctx?: ExtensionContext): void {
		// Bump requestId so any in-flight async refresh knows it is now stale.
		this.requestId++;
		this.refreshFailures = 0;
		this.cache = { createdAt: Date.now(), report };
		this._state = "loaded";
		if (ctx) this.scheduleRefresh(ctx);
		else this.clearTimer();
		this.onRender?.();
	}

	/**
	 * Refresh Codex usage data, respecting the cache TTL unless forced.
	 *
	 * Flow:
	 *  1. If the cache is still fresh and `force` is false → just reschedule
	 *     and return; no network call needed.
	 *  2. If there is no cached data at all → flip to `loading` so the chip
	 *     shows a spinner-like "checking" label instead of stale content.
	 *  3. Fetch usage.  If this request's generation is outdated by the time
	 *     the response arrives, silently discard it.
	 *  4. On success → cache the report, schedule the next refresh.
	 *  5. On failure → flip to `error` only when `showErrors` is true (i.e.
	 *     the active model is a Codex model); otherwise demote gracefully to
	 *     `loaded` (if prior data exists) or `idle`.
	 */
	async refresh(
		ctx: ExtensionContext,
		force: boolean,
		model: CodexUsageModel | undefined = ctx.model,
		options: CodexRefreshOptions = {},
	): Promise<void> {
		const requestId = ++this.requestId;

		if (this.isCacheFresh() && !force) {
			// Cache is still valid – just ensure the timer is armed for the next cycle.
			this.scheduleRefresh(ctx);
			this._state = "loaded";
			this.onRender?.();
			return;
		}

		// Only show a loading indicator when there is no prior data; otherwise
		// the existing data stays visible until the new fetch completes.
		if (!this.cache) {
			this._state = "loading";
			this.onRender?.();
		}

		const result = await queryUsage(ctx, { timeoutMs: DEFAULT_TIMEOUT_MS });

		// Stale-request guard: a newer refresh (or clear) has superseded this one.
		if (requestId !== this.requestId) return;

		if (!result.ok) {
			// Determine the appropriate degraded state:
			//  - `error`  → user is on a Codex model and should see the red accent
			//  - `loaded` → prior data exists; keep showing it quietly
			//  - `idle`   → no data and not relevant to the current model
			const showErrors = options.showErrors ?? isOpenAICodexModel(model);
			this.refreshFailures++;
			this._state = showErrors ? "error" : this.cache ? "loaded" : "idle";
			if (showErrors || this.cache) this.scheduleAfterFailure(ctx);
			else this.clearTimer();
			this.onRender?.();
			return;
		}

		this.refreshFailures = 0;
		this.cache = { createdAt: Date.now(), report: result.report };
		this._state = "loaded";
		this.scheduleRefresh(ctx);
		this.onRender?.();
	}

	/**
	 * Reset all state – called when the infobar is disabled or the session
	 * shuts down.  Bumping `requestId` ensures any in-flight fetch is discarded.
	 */
	clear(): void {
		this.requestId++;
		this.refreshFailures = 0;
		this.clearTimer();
		this.cache = undefined;
		this._state = "idle";
		this.onRender?.();
	}

	/**
	 * Permanently tear down the manager.  Unlike `clear()`, this also detaches
	 * the render callback so no further renders are triggered after disposal.
	 */
	dispose(): void {
		this.clearTimer();
		this.onRender = undefined;
	}

	/**
	 * Schedule a forced background refresh to fire when the current cache entry
	 * is about to expire.
	 *
	 * We compute the remaining TTL from `cache.createdAt` so that calling
	 * `scheduleRefresh` multiple times (e.g. after `setReport` followed by an
	 * event handler) always targets the same absolute expiry, preventing timer
	 * drift from postponing refreshes indefinitely.
	 */
	private scheduleRefresh(ctx: ExtensionContext): void {
		this.scheduleTimer(ctx, this.cacheRefreshDelayMs());
	}

	/**
	 * After a failed refresh, preserve the normal cache-expiry timer when the
	 * cache is still fresh.  If the cache is already stale (or absent), retry
	 * with exponential backoff instead of scheduling a 0ms immediate loop.
	 */
	private scheduleAfterFailure(ctx: ExtensionContext): void {
		if (this.cache && this.isCacheFresh()) {
			this.scheduleRefresh(ctx);
			return;
		}
		this.scheduleTimer(ctx, this.refreshRetryDelayMs());
	}

	private cacheRefreshDelayMs(): number {
		if (!this.cache) return CACHE_TTL_MS;
		const elapsed = Math.max(0, Date.now() - this.cache.createdAt);
		return Math.max(0, CACHE_TTL_MS - elapsed);
	}

	private refreshRetryDelayMs(): number {
		const failures = Math.max(1, this.refreshFailures);
		return Math.min(CACHE_TTL_MS, REFRESH_RETRY_BASE_MS * 2 ** (failures - 1));
	}

	/**
	 * `unref()` keeps this timer from preventing Node.js from exiting if the
	 * extension is the only thing keeping the process alive.
	 */
	private scheduleTimer(ctx: ExtensionContext, delayMs: number): void {
		this.clearTimer();
		const delay = Math.max(0, delayMs);
		this.refreshTimer = setTimeout(() => {
			void this.refresh(ctx, true);
		}, delay);
		this.refreshTimer.unref?.();
	}

	private clearTimer(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}
}

// ── Command Argument Parsing ─────────────────────────────────────────

/**
 * Parse the raw argument string from the `/codex-status` slash command into
 * a typed options object.
 *
 * Accepted flags:
 *   --refresh           Force a fresh fetch even if the cache is still valid.
 *   --no-statusline     Run the query but don't push the result to the footer.
 *   --clear-statusline  Clear the cached report from the footer chip.
 *   --timeout <seconds> Override the default 15-second query timeout (1–120 s).
 *
 * Returns `{ ok: false, error }` for any unknown flag or malformed value so
 * the caller can surface a user-facing notification without throwing.
 */
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

/**
 * Format a full CodexUsageReport into a multi-line human-readable string
 * suitable for a TUI notification.  Each rate-limit snapshot gets its own
 * section with a progress bar and a reset countdown.
 */
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
		// Secondary snapshots (non-primary Codex limits) get an identifying label.
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

/**
 * Display a formatted Codex usage report as a TUI notification.
 *
 * Prepends the ANSI foreground-reset sequence when running inside the TUI so
 * the notification text is not accidentally coloured by a prior escape code.
 */
export function showCodexReport(
	ctx: ExtensionCommandContext,
	report: CodexUsageReport,
	fromCache: boolean,
): void {
	const text = formatCodexUsageReport(report);
	ctx.ui.notify(ctx.hasUI ? `${RESET_FOREGROUND}${text}` : text, "info");
}

/**
 * Build a user-facing error message from one or more failed usage query
 * attempts, including actionable remediation steps.
 */
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

/**
 * Choose the most relevant rate-limit snapshot from a report for a given model.
 *
 * Selection priority:
 *  1. If the model is not a Codex model → return the primary "codex" snapshot
 *     (or the first available snapshot) as a generic fallback.
 *  2. Exact match by normalised `limitId` or `limitName` against the model's
 *     own `id` / `name` keys.
 *  3. Fuzzy variant match: strip the `codex-` prefix from the model key and
 *     look for a snapshot whose key *contains* that token as a dash-delimited
 *     segment (e.g. model `codex-mini` matches snapshot `codex-mini-highres`
 *     only when it is the sole candidate for that variant).
 *  4. Fall back to the primary "codex" snapshot or the first snapshot.
 */
export function selectSnapshotForModel(
	report: CodexUsageReport,
	model: CodexUsageModel | undefined,
): NormalizedRateLimitSnapshot | undefined {
	const codexSnapshot = report.snapshots.find(isPrimaryCodexSnapshot);
	// Non-Codex models don't have per-model rate limits – use the generic snapshot.
	if (!model || !isOpenAICodexModel(model)) return codexSnapshot ?? report.snapshots[0];

	// Build a set of normalised keys for the active model (id + name variants).
	const modelKeys = normalizedModelUsageKeys(model);
	const exactMatch = report.snapshots.find((snapshot) =>
		normalizedSnapshotUsageKeys(snapshot).some((key) => modelKeys.has(key)),
	);
	if (exactMatch) return exactMatch;

	// No exact match – try matching on the variant suffix of the model key
	// (e.g. "mini" from "codex-mini") against snapshot limit IDs.
	const variants = codexModelVariantKeys(modelKeys);
	for (const variant of variants) {
		const matches = report.snapshots.filter(
			(snapshot) =>
				!isPrimaryCodexSnapshot(snapshot) &&
				normalizedSnapshotUsageKeys(snapshot).some((key) =>
					normalizedKeyHasToken(key, variant),
				),
		);
		// Only use the match when it is unambiguous (exactly one snapshot).
		if (matches.length === 1) return matches[0];
	}

	return codexSnapshot ?? report.snapshots[0];
}

// ── Internal Formatting Helpers ──────────────────────────────────────

/**
 * Return `true` when the snapshot represents the top-level "codex" rate-limit
 * bucket (as opposed to a per-model or per-feature sub-limit).
 */
function isPrimaryCodexSnapshot(snapshot: NormalizedRateLimitSnapshot): boolean {
	return (
		normalizedUsageKey(snapshot.limitId) === "codex" ||
		normalizedUsageKey(snapshot.limitName) === "codex"
	);
}

/** Format one rate-limit window as a single padded report line. */
function formatWindowLine(label: string, window: NormalizedRateLimitWindow): string {
	return `  ${label.padEnd(LIMIT_VALUE_COLUMN)}${formatWindow(window)}`;
}

/**
 * Render a window as `[████░░░░] 73% left (resets 14:30)`.
 * `percentRemaining` is derived from `usedPercent` so 0% used = full bar.
 */
function formatWindow(window: NormalizedRateLimitWindow): string {
	const remaining = 100 - clampPercent(window.usedPercent);
	const reset = window.resetsAt ? ` (resets ${formatReset(window.resetsAt)})` : "";
	return `${progressBar(remaining)} ${remaining.toFixed(0)}% left${reset}`;
}

/**
 * Render an ASCII progress bar of fixed width `BAR_SEGMENTS` segments.
 * @param percentRemaining  A value in [0, 100] representing remaining capacity.
 */
function progressBar(percentRemaining: number): string {
	const filled = Math.round((clampPercent(percentRemaining) / 100) * BAR_SEGMENTS);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

/**
 * Format the `balance` field of a credits snapshot for display in the chip.
 * Handles the four known states: no credits, unlimited, known balance, and
 * credits confirmed but balance unavailable.
 */
export function formatCredits(credits: NormalizedCredits): string {
	if (!credits.hasCredits) return "no credits";
	if (credits.unlimited) return "unlimited credits";
	const balance = credits.balance?.trim();
	if (!balance) return "credits available";
	return `${formatNumber(Number(balance), balance)} credits`;
}

/**
 * Format a Unix epoch timestamp (seconds) as a human-readable reset time.
 *   - Same calendar day → just the HH:MM time (e.g. "14:30")
 *   - Different day     → "HH:MM on D Mon" (e.g. "02:00 on 3 Jul")
 */
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

/** Format a number with locale-aware grouping, falling back to a raw string. */
function formatNumber(value: number, fallback: string): string {
	if (!Number.isFinite(value)) return fallback;
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

/** Clamp a percentage value to [0, 100], treating NaN/Infinity as 0. */
function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

// ── Snapshot Key Matching ────────────────────────────────────────────

/**
 * Build a normalised set of usage keys for a model, including both the
 * raw `id` and `name` fields, plus suffix variants that strip everything
 * before the first occurrence of "codex" (e.g. "openai-codex-mini" → "codex-mini").
 *
 * This widens the match surface so snapshot IDs like "codex-mini-2025-05-16"
 * can be matched by a model whose id is "openai-codex-mini".
 */
function normalizedModelUsageKeys(model: CodexUsageModel): Set<string> {
	const keys = new Set<string>();
	addNormalizedUsageKey(keys, model.id);
	addNormalizedUsageKey(keys, model.name);

	// Add sub-keys starting from "codex" to handle provider-prefixed ids.
	for (const key of [...keys]) {
		const codexIndex = key.indexOf("codex");
		if (codexIndex >= 0) keys.add(key.slice(codexIndex));
	}

	return keys;
}

/** Return the normalised limitId and limitName for a snapshot as an array. */
function normalizedSnapshotUsageKeys(snapshot: NormalizedRateLimitSnapshot): string[] {
	return [normalizedUsageKey(snapshot.limitId), normalizedUsageKey(snapshot.limitName)].filter(
		(key): key is string => key !== undefined,
	);
}

/** Add a normalised key to the set if it is non-empty after normalisation. */
function addNormalizedUsageKey(keys: Set<string>, value: string | undefined): void {
	const key = normalizedUsageKey(value);
	if (key) keys.add(key);
}

/**
 * Normalise an arbitrary string to a lowercase, hyphen-separated identifier.
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
 * Extract the variant suffix that follows `codex-` in each model key.
 * For example "codex-mini" produces the variant "mini".
 * These variants are used for fuzzy snapshot matching when no exact key match exists.
 */
function codexModelVariantKeys(modelKeys: Set<string>): string[] {
	const variants = new Set<string>();
	for (const key of modelKeys) {
		const match = key.match(/(?:^|-)codex-(.+)$/);
		if (match?.[1]) variants.add(match[1]);
	}
	return [...variants];
}

/**
 * Return `true` when `token` appears as a complete dash-delimited segment
 * inside `key`, preventing partial substring matches.
 *
 * Examples:
 *   normalizedKeyHasToken("codex-mini-highres", "mini") → true
 *   normalizedKeyHasToken("codex-mini-highres", "high") → false  (no full segment)
 *   normalizedKeyHasToken("mini", "mini")               → true
 */
function normalizedKeyHasToken(key: string, token: string): boolean {
	return (
		key === token ||
		key.startsWith(`${token}-`) ||
		key.endsWith(`-${token}`) ||
		key.includes(`-${token}-`)
	);
}
