import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	AppServerCreditsSnapshot,
	AppServerRateLimitResponse,
	AppServerRateLimitSnapshot,
	AppServerWindowSnapshot,
	BackendAdditionalRateLimit,
	BackendCreditsSnapshot,
	BackendRateLimitDetails,
	BackendWindowSnapshot,
	CodexUsageModel,
	CodexUsageReport,
	NormalizedCredits,
	NormalizedRateLimitSnapshot,
	NormalizedRateLimitWindow,
	PendingRpc,
	QueryUsageResult,
	RateLimitStatusPayload,
	RpcResponse,
	UsageQueryError,
	UsageSource,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────────

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_ERROR_BODY_CHARS = 600;

// ── Public API ───────────────────────────────────────────────────────

export function isOpenAICodexModel(
	model: Pick<CodexUsageModel, "provider"> | undefined,
): boolean {
	return model?.provider === CODEX_PROVIDER_ID;
}

export async function queryUsage(
	ctx: ExtensionContext,
	options: { timeoutMs: number },
): Promise<QueryUsageResult> {
	const errors: UsageQueryError[] = [];
	const deadline = Date.now() + options.timeoutMs;
	const remainingTimeoutMs = () => Math.max(1, deadline - Date.now());

	try {
		const report = await queryViaPiAuth(ctx, remainingTimeoutMs());
		return { ok: true, report };
	} catch (cause) {
		errors.push({ source: "pi-auth", message: errorMessage(cause), cause });
	}

	const fallbackTimeoutMs = deadline - Date.now();
	if (fallbackTimeoutMs <= 0) {
		errors.push({
			source: "codex-app-server",
			message: `Skipped Codex app-server fallback because the ${Math.round(
				options.timeoutMs / 1000,
			)}s usage query timeout was exhausted.`,
		});
		return { ok: false, errors };
	}

	try {
		const report = await queryViaCodexAppServer(Math.max(1, fallbackTimeoutMs));
		return { ok: true, report };
	} catch (cause) {
		errors.push({ source: "codex-app-server", message: errorMessage(cause), cause });
	}

	return { ok: false, errors };
}

// ── Pi Auth Query ────────────────────────────────────────────────────

type PiModel = NonNullable<ExtensionContext["model"]>;

async function queryViaPiAuth(
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<CodexUsageReport> {
	const auth = await resolvePiCodexAuth(ctx);
	if (!auth) {
		throw new Error(
			"No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
		);
	}

	const response = await fetchWithTimeout(
		CODEX_USAGE_URL,
		{ headers: auth.headers },
		timeoutMs,
	);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
		);
	}

	const payload = parseJsonObject(text, "Codex usage endpoint response");
	return normalizeBackendPayload(payload as RateLimitStatusPayload, Date.now(), "pi-auth");
}

async function resolvePiCodexAuth(
	ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
	const models = codexAuthCandidateModels(ctx);
	const errors: string[] = [];

	for (const model of models) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			errors.push(auth.error);
			continue;
		}

		const headers = { ...(auth.headers ?? {}) };
		const bearerToken = bearerTokenFromHeaders(headers) ?? auth.apiKey;
		if (!hasHeader(headers, "Authorization") && bearerToken) {
			headers.Authorization = `Bearer ${bearerToken}`;
		}

		const accountId = bearerToken ? extractChatGptAccountId(bearerToken) : undefined;
		if (accountId && !hasHeader(headers, "ChatGPT-Account-Id")) {
			headers["ChatGPT-Account-Id"] = accountId;
		}
		if (!hasHeader(headers, "originator")) {
			headers.originator = "pi";
		}
		if (!hasHeader(headers, "User-Agent")) {
			headers["User-Agent"] = "pi-codex-usage";
		}
		if (bearerToken || hasHeader(headers, "Authorization")) {
			return { headers };
		}
	}

	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
	return undefined;
}

function codexAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: PiModel | undefined) => {
		if (!model || model.provider !== CODEX_PROVIDER_ID) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};

	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable()) add(model);
	for (const model of ctx.modelRegistry.getAll()) add(model);
	return candidates;
}

// ── Codex App Server Query ───────────────────────────────────────────

async function queryViaCodexAppServer(timeoutMs: number): Promise<CodexUsageReport> {
	const client = new CodexAppServerClient(timeoutMs);
	try {
		await client.start();
		await client.request("initialize", {
			clientInfo: {
				name: "pi_codex_usage",
				title: "Pi Codex Usage",
				version: "0.1.0",
			},
			capabilities: {
				experimentalApi: false,
				requestAttestation: false,
				optOutNotificationMethods: [],
			},
		});
		client.notify("initialized");
		const result = await client.request("account/rateLimits/read", undefined);
		return normalizeAppServerResponse(
			assertObject(result, "account/rateLimits/read result") as AppServerRateLimitResponse,
			Date.now(),
		);
	} finally {
		client.dispose();
	}
}

class CodexAppServerClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private stderr = "";
	private readonly pending = new Map<number, PendingRpc>();
	private startPromise?: Promise<void>;
	private exitError?: Error;
	private readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		this.timeoutMs = timeoutMs;
	}

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise;

		this.startPromise = new Promise((resolve, reject) => {
			const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;

			const startupTimeout = setTimeout(() => {
				reject(
					new Error(
						`Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`,
					),
				);
			}, this.timeoutMs);

			child.once("spawn", () => {
				clearTimeout(startupTimeout);
				resolve();
			});

			child.once("error", (error) => {
				clearTimeout(startupTimeout);
				reject(new Error(`Failed to start codex app-server: ${error.message}`));
				this.rejectAll(error);
			});

			child.once("exit", (code, signal) => {
				const suffix = this.stderr ? ` stderr: ${redactErrorBody(this.stderr)}` : "";
				this.exitError = new Error(
					`codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"}).${suffix}`,
				);
				this.rejectAll(this.exitError);
			});

			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
			});

			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => this.handleLine(line));
		});

		return this.startPromise;
	}

	request(method: string, params: unknown): Promise<unknown> {
		const child = this.child;
		if (!child?.stdin.writable) {
			throw new Error("codex app-server is not running.");
		}
		if (this.exitError) throw this.exitError;

		const id = this.nextId++;
		const payload = params === undefined ? { method, id } : { method, id, params };
		const response = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						`Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`,
					),
				);
			}, this.timeoutMs);

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
		});

		child.stdin.write(`${JSON.stringify(payload)}\n`);
		return response;
	}

	notify(method: string): void {
		const child = this.child;
		if (!child?.stdin.writable) return;
		child.stdin.write(`${JSON.stringify({ method })}\n`);
	}

	dispose(): void {
		for (const [id, pending] of this.pending) {
			pending.reject(new Error(`codex app-server request ${id} cancelled.`));
		}
		this.pending.clear();

		const child = this.child;
		if (!child) return;
		child.stdin.end();
		if (!child.killed) child.kill();
		this.child = undefined;
	}

	private handleLine(line: string): void {
		let parsed: RpcResponse;
		try {
			parsed = JSON.parse(line) as RpcResponse;
		} catch {
			return;
		}

		if (typeof parsed.id !== "number") return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);

		if (parsed.error) {
			const message =
				typeof parsed.error.message === "string" ? parsed.error.message : "unknown error";
			pending.reject(new Error(`codex app-server request failed: ${message}`));
			return;
		}

		pending.resolve(parsed.result);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

// ── Backend Payload Normalization ────────────────────────────────────

export function normalizeBackendPayload(
	payload: RateLimitStatusPayload,
	capturedAt: number,
	source: UsageSource,
): CodexUsageReport {
	const snapshots: NormalizedRateLimitSnapshot[] = [];
	const planType = asString(payload.plan_type);
	const primary = normalizeBackendSnapshot(
		"codex",
		undefined,
		payload.rate_limit,
		payload.credits,
	);
	if (primary) snapshots.push(primary);

	const additional = Array.isArray(payload.additional_rate_limits)
		? payload.additional_rate_limits
		: [];
	for (const item of additional) {
		const additionalLimit = assertObject(
			item,
			"additional rate limit",
		) as BackendAdditionalRateLimit;
		const limitId =
			asString(additionalLimit.metered_feature) ?? asString(additionalLimit.limit_name);
		if (!limitId) continue;
		const snapshot = normalizeBackendSnapshot(
			limitId,
			asString(additionalLimit.limit_name),
			additionalLimit.rate_limit,
			undefined,
		);
		if (snapshot) snapshots.push(snapshot);
	}

	if (snapshots.length === 0) {
		throw new Error("Codex usage endpoint returned no displayable rate-limit windows.");
	}

	return { source, capturedAt, planType, snapshots };
}

function normalizeBackendSnapshot(
	limitId: string,
	limitName: string | undefined,
	rateLimit: unknown,
	credits: unknown,
): NormalizedRateLimitSnapshot | undefined {
	if (rateLimit === null || rateLimit === undefined) {
		const normalizedCredits = normalizeBackendCredits(credits);
		return normalizedCredits ? { limitId, limitName, credits: normalizedCredits } : undefined;
	}

	const details = assertObject(rateLimit, "rate limit") as BackendRateLimitDetails;
	const primary = normalizeBackendWindow(details.primary_window);
	const secondary = normalizeBackendWindow(details.secondary_window);
	const normalizedCredits = normalizeBackendCredits(credits);

	if (!primary && !secondary && !normalizedCredits) return undefined;
	return { limitId, limitName, primary, secondary, credits: normalizedCredits };
}

function normalizeBackendWindow(value: unknown): NormalizedRateLimitWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = assertObject(value, "rate-limit window") as BackendWindowSnapshot;
	const usedPercent = asNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const limitSeconds = asNumber(window.limit_window_seconds);
	const resetsAt = asNumber(window.reset_at);
	return {
		usedPercent,
		windowMinutes: limitSeconds && limitSeconds > 0 ? Math.ceil(limitSeconds / 60) : undefined,
		resetsAt,
	};
}

function normalizeBackendCredits(value: unknown): NormalizedCredits | undefined {
	if (value === null || value === undefined) return undefined;
	const credits = assertObject(value, "credits") as BackendCreditsSnapshot;
	const hasCredits = asBoolean(credits.has_credits);
	const unlimited = asBoolean(credits.unlimited);
	if (hasCredits === undefined || unlimited === undefined) return undefined;
	return { hasCredits, unlimited, balance: asString(credits.balance) };
}

// ── App Server Response Normalization ────────────────────────────────

export function normalizeAppServerResponse(
	response: AppServerRateLimitResponse,
	capturedAt: number,
): CodexUsageReport {
	const snapshots: NormalizedRateLimitSnapshot[] = [];
	const addSnapshot = (raw: unknown, fallbackId: string) => {
		const snapshot = normalizeAppServerSnapshot(raw, fallbackId);
		if (!snapshot) return;
		const existingIndex = snapshots.findIndex((item) => item.limitId === snapshot.limitId);
		if (existingIndex >= 0)
			snapshots[existingIndex] = mergeSnapshot(snapshots[existingIndex], snapshot);
		else snapshots.push(snapshot);
	};

	addSnapshot(response.rateLimits, "codex");
	if (response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object") {
		for (const [limitId, raw] of Object.entries(response.rateLimitsByLimitId)) {
			addSnapshot(raw, limitId);
		}
	}

	if (snapshots.length === 0) {
		throw new Error("codex app-server returned no displayable rate-limit windows.");
	}

	const planType = asAppServerPlanType(response.rateLimits);
	return { source: "codex-app-server", capturedAt, planType, snapshots };
}

function asAppServerPlanType(raw: unknown): string | undefined {
	if (raw === null || raw === undefined) return undefined;
	const snapshot = assertObject(
		raw,
		"app-server rate-limit snapshot",
	) as AppServerRateLimitSnapshot;
	return asString(snapshot.planType);
}

function normalizeAppServerSnapshot(
	raw: unknown,
	fallbackId: string,
): NormalizedRateLimitSnapshot | undefined {
	if (raw === null || raw === undefined) return undefined;
	const snapshot = assertObject(
		raw,
		"app-server rate-limit snapshot",
	) as AppServerRateLimitSnapshot;
	const limitId = asString(snapshot.limitId) ?? fallbackId;
	const limitName = asString(snapshot.limitName);
	const primary = normalizeAppServerWindow(snapshot.primary);
	const secondary = normalizeAppServerWindow(snapshot.secondary);
	const credits = normalizeAppServerCredits(snapshot.credits);
	if (!primary && !secondary && !credits) return undefined;
	return { limitId, limitName, primary, secondary, credits };
}

function normalizeAppServerWindow(value: unknown): NormalizedRateLimitWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = assertObject(
		value,
		"app-server rate-limit window",
	) as AppServerWindowSnapshot;
	const usedPercent = asNumber(window.usedPercent);
	if (usedPercent === undefined) return undefined;
	return {
		usedPercent,
		windowMinutes: asNumber(window.windowDurationMins),
		resetsAt: asNumber(window.resetsAt),
	};
}

function normalizeAppServerCredits(value: unknown): NormalizedCredits | undefined {
	if (value === null || value === undefined) return undefined;
	const credits = assertObject(value, "app-server credits") as AppServerCreditsSnapshot;
	const hasCredits = asBoolean(credits.hasCredits);
	const unlimited = asBoolean(credits.unlimited);
	if (hasCredits === undefined || unlimited === undefined) return undefined;
	return { hasCredits, unlimited, balance: asString(credits.balance) };
}

function mergeSnapshot(
	left: NormalizedRateLimitSnapshot,
	right: NormalizedRateLimitSnapshot,
): NormalizedRateLimitSnapshot {
	return {
		limitId: right.limitId || left.limitId,
		limitName: right.limitName ?? left.limitName,
		primary: right.primary ?? left.primary,
		secondary: right.secondary ?? left.secondary,
		credits: right.credits ?? left.credits,
	};
}

// ── Fetch Utilities ──────────────────────────────────────────────────

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(
				`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching Codex usage.`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

// ── Parsing Utilities ────────────────────────────────────────────────

function parseJsonObject(text: string, description: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${description} was not valid JSON: ${errorMessage(error)}`);
	}
	return assertObject(parsed, description);
}

function assertObject(value: unknown, description: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${description} was not an object.`);
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function bearerTokenFromHeaders(headers: Record<string, string>): string | undefined {
	const authorization = headerValue(headers, "Authorization");
	const match = authorization?.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || undefined;
}

function extractChatGptAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const authClaim = payload?.[JWT_CLAIM_PATH];
	if (!authClaim || typeof authClaim !== "object" || Array.isArray(authClaim)) {
		return undefined;
	}
	const accountId = (authClaim as Record<string, unknown>).chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(decoded) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return headerValue(headers, name) !== undefined;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const header = Object.entries(headers).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	);
	return header?.[1];
}

function redactErrorBody(body: string): string {
	return truncateEnd(
		body
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
			.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
			.trim(),
		MAX_ERROR_BODY_CHARS,
	);
}

function truncateEnd(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
