import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CodexUsageManager } from "./codex-usage/index.js";

// ── Thinking ─────────────────────────────────────────────────────────

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

// ── Runtime ──────────────────────────────────────────────────────────

export interface RuntimeState {
  thinkingLevel: ThinkingLevel;
  requestRender?: () => void;
  renderVersion: number;
  context: { label: string; color: string };
  tokenTotals: TokenTotals;
  codexUsage: CodexUsageManager;
}

// ── Tokens / Cost ────────────────────────────────────────────────────

export interface TokenTotals {
  input: number;
  output: number;
  cost: number;
}

// ── Chip UI ──────────────────────────────────────────────────────────

export interface Chip {
  label: string;
  value: string;
  accent: string;
  priority: 1 | 2 | 3;
  labelFg?: string;
  valueFg?: string;
  valueBg?: string;
  boldValue?: boolean;
}

// ── Git ──────────────────────────────────────────────────────────────

export interface GitSnapshot {
  branch?: string;
  worktreeName?: string;
  statusParts?: GitStatusPart[];
  dirty: boolean;
  expiresAt: number;
}

export interface GitStatusPart {
  symbol: string;
  count: number;
  color: string;
}

export interface GitStatusCounts {
  conflicted: number;
  modified: number;
  untracked: number;
  staged: number;
  renamed: number;
  deleted: number;
  ahead: number;
  behind: number;
}
