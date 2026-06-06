import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

import type { GitSnapshot, GitStatusCounts, GitStatusPart } from "./types.js";
import { COLOR } from "./theme.js";

// ── Constants ────────────────────────────────────────────────────────

const GIT_CACHE_TTL_MS = 2_000;
const GIT_COMMAND_TIMEOUT_MS = 350;

// ── Cache ────────────────────────────────────────────────────────────

const gitCache = new Map<string, GitSnapshot>();

// ── Public API ───────────────────────────────────────────────────────

export function getGitSnapshot(cwd: string, fallbackBranch?: string): GitSnapshot {
  const now = Date.now();
  const cached = gitCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return fallbackBranch && cached.branch !== fallbackBranch ? { ...cached, branch: fallbackBranch } : cached;
  }

  try {
    const worktreeRoot = execGit(cwd, ["rev-parse", "--show-toplevel"]);
    const worktreeName = getLinkedWorktreeName(cwd, worktreeRoot);
    const statusOutput = execGit(cwd, ["status", "--porcelain=v1", "--branch"]);
    const parsed = parseGitStatus(statusOutput);
    const snapshot: GitSnapshot = {
      branch: fallbackBranch ?? parsed.branch,
      worktreeName,
      statusParts: formatGitStatus(parsed.counts),
      dirty: isDirty(parsed.counts),
      expiresAt: now + GIT_CACHE_TTL_MS,
    };
    gitCache.set(cwd, snapshot);
    return snapshot;
  } catch {
    const snapshot: GitSnapshot = {
      branch: fallbackBranch,
      dirty: false,
      expiresAt: now + GIT_CACHE_TTL_MS,
    };
    gitCache.set(cwd, snapshot);
    return snapshot;
  }
}

// ── Git Commands ─────────────────────────────────────────────────────

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_COMMAND_TIMEOUT_MS,
  }).trim();
}

function getLinkedWorktreeName(cwd: string, worktreeRoot: string): string | undefined {
  try {
    const gitDir = execGit(cwd, ["rev-parse", "--absolute-git-dir"]);
    if (basename(dirname(gitDir)) !== "worktrees") return undefined;
    return basename(worktreeRoot) || undefined;
  } catch {
    return undefined;
  }
}

// ── Status Parsing ───────────────────────────────────────────────────

function parseGitStatus(output: string): { branch?: string; counts: GitStatusCounts } {
  const counts: GitStatusCounts = {
    conflicted: 0,
    modified: 0,
    untracked: 0,
    staged: 0,
    renamed: 0,
    deleted: 0,
    ahead: 0,
    behind: 0,
  };
  let branch: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;

    if (line.startsWith("## ")) {
      branch = parseStatusBranch(line.slice(3));
      counts.ahead += Number(line.match(/ahead (\d+)/)?.[1] ?? 0);
      counts.behind += Number(line.match(/behind (\d+)/)?.[1] ?? 0);
      continue;
    }

    const x = line[0];
    const y = line[1];
    const xy = `${x}${y}`;

    if (xy === "??") {
      counts.untracked += 1;
      continue;
    }
    if (xy === "!!") continue;
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) {
      counts.conflicted += 1;
      continue;
    }

    if (x === "R" || x === "C") counts.renamed += 1;
    else if (x === "D") counts.deleted += 1;
    else if (x !== " ") counts.staged += 1;

    if (y === "D") counts.deleted += 1;
    else if (y === "M" || y === "T") counts.modified += 1;
  }

  return { branch, counts };
}

function parseStatusBranch(header: string): string | undefined {
  const value = header.replace(/\s+\[[^\]]+\]$/, "").split("...")[0];
  if (!value || value.startsWith("HEAD ")) return undefined;
  return value;
}

// ── Status Formatting ────────────────────────────────────────────────

function formatGitStatus(counts: GitStatusCounts): GitStatusPart[] | undefined {
  const parts = [
    formatGitStatusPart("=", counts.conflicted, COLOR.contextRed),
    formatGitStatusPart("⇡", counts.ahead, COLOR.gitStaged),
    formatGitStatusPart("⇣", counts.behind, COLOR.gitDeleted),
    formatGitStatusPart("✘", counts.untracked, COLOR.gitUntracked),
    formatGitStatusPart("~", counts.modified, COLOR.gitModified),
    formatGitStatusPart("+", counts.staged, COLOR.gitStaged),
    formatGitStatusPart("»", counts.renamed, COLOR.gitRenamed),
    formatGitStatusPart("-", counts.deleted, COLOR.gitDeleted),
  ].filter((part): part is GitStatusPart => part !== undefined);

  return parts.length > 0 ? parts : undefined;
}

function formatGitStatusPart(symbol: string, count: number, color: string): GitStatusPart | undefined {
  return count > 0 ? { symbol, count, color } : undefined;
}

function isDirty(counts: GitStatusCounts): boolean {
  return counts.conflicted + counts.modified + counts.untracked + counts.staged + counts.renamed + counts.deleted > 0;
}
