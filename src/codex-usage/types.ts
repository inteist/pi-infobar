import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Public Types ─────────────────────────────────────────────────────

export type UsageSource = "pi-auth" | "codex-app-server";

type PiModel = NonNullable<ExtensionContext["model"]>;
export type CodexUsageModel = Pick<PiModel, "id" | "name" | "provider">;

export interface CodexUsageReport {
	source: UsageSource;
	capturedAt: number;
	planType?: string;
	snapshots: NormalizedRateLimitSnapshot[];
}

export interface NormalizedRateLimitSnapshot {
	limitId: string;
	limitName?: string;
	primary?: NormalizedRateLimitWindow;
	secondary?: NormalizedRateLimitWindow;
	credits?: NormalizedCredits;
}

export interface NormalizedRateLimitWindow {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
}

export interface NormalizedCredits {
	hasCredits: boolean;
	unlimited: boolean;
	balance?: string;
}

// ── Query Result ─────────────────────────────────────────────────────

export type QueryUsageResult =
	| { ok: true; report: CodexUsageReport }
	| { ok: false; errors: UsageQueryError[] };

export interface UsageQueryError {
	source: UsageSource;
	message: string;
	cause?: unknown;
}

// ── Backend Response Types (ChatGPT API) ─────────────────────────────

export interface RateLimitStatusPayload {
	plan_type?: unknown;
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
	credits?: unknown;
}

export interface BackendRateLimitDetails {
	primary_window?: unknown;
	secondary_window?: unknown;
}

export interface BackendWindowSnapshot {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
}

export interface BackendAdditionalRateLimit {
	limit_name?: unknown;
	metered_feature?: unknown;
	rate_limit?: unknown;
}

export interface BackendCreditsSnapshot {
	has_credits?: unknown;
	unlimited?: unknown;
	balance?: unknown;
}

// ── App Server Response Types ────────────────────────────────────────

export interface AppServerRateLimitResponse {
	rateLimits?: unknown;
	rateLimitsByLimitId?: unknown;
}

export interface AppServerRateLimitSnapshot {
	limitId?: unknown;
	limitName?: unknown;
	primary?: unknown;
	secondary?: unknown;
	credits?: unknown;
	planType?: unknown;
}

export interface AppServerWindowSnapshot {
	usedPercent?: unknown;
	windowDurationMins?: unknown;
	resetsAt?: unknown;
}

export interface AppServerCreditsSnapshot {
	hasCredits?: unknown;
	unlimited?: unknown;
	balance?: unknown;
}

// ── Stdio RPC Types ─────────────────────────────────────────────────

export interface RpcResponse {
	id?: unknown;
	result?: unknown;
	error?: { message?: unknown; code?: unknown };
}

export interface PendingRpc {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}
