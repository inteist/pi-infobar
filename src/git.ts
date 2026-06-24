import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

import type { GitSnapshot, GitStatusCounts, GitStatusPart } from "./types.js";
import { COLOR } from "./theme.js";

// ── Constants ────────────────────────────────────────────────────────

/** How long a cached git snapshot stays valid before a fresh query is issued. */
const GIT_CACHE_TTL_MS = 2_000;

/** Maximum time to wait for any single git subprocess before killing it.
 *  Kept very short because the footer renders synchronously on every frame. */
const GIT_COMMAND_TIMEOUT_MS = 350;

/** Maximum number of distinct cwd entries to keep in the cache.
 *  Prevents unbounded growth when the agent switches between many worktrees. */
const GIT_CACHE_MAX_SIZE = 50;

// ── Cache ────────────────────────────────────────────────────────────

/**
 * Module-level LRU cache keyed by the working-directory path.
 * Entries expire after GIT_CACHE_TTL_MS; stale entries are evicted lazily
 * before each write, and the least-recently-used live entry is removed before
 * inserting a new key would exceed GIT_CACHE_MAX_SIZE.
 */
const gitCache = new Map<string, GitSnapshot>();

// ── Public API ───────────────────────────────────────────────────────

/**
 * Return a git snapshot for `cwd`, using a short-lived in-memory cache so
 * that rapid re-renders do not spawn a new git process on every frame.
 *
 * @param cwd            The working directory to inspect.
 * @param fallbackBranch Branch name already known from the footer-data
 *                       provider (e.g. from a pi session event).  Used when
 *                       git is unavailable or to override a detached-HEAD
 *                       situation where `git status` would return no branch.
 */
export function getGitSnapshot(cwd: string, fallbackBranch?: string): GitSnapshot {
  const now = Date.now();
  const cached = gitCache.get(cwd);

  // Return the cached snapshot if it has not expired yet.
  // If the caller supplied a fallbackBranch that differs from what git
  // reported (e.g. the session switched branches between cache refreshes),
  // overlay it without invalidating the rest of the snapshot.
  if (cached && cached.expiresAt > now) {
    touchGitCacheEntry(cwd, cached);
    return fallbackBranch && cached.branch !== fallbackBranch ? { ...cached, branch: fallbackBranch } : cached;
  }

  try {
    // Resolve the true worktree root so we can detect linked worktrees.
    const worktreeRoot = execGit(cwd, ["rev-parse", "--show-toplevel"]);
    const worktreeName = getLinkedWorktreeName(cwd, worktreeRoot);

    // `--porcelain=v1 --branch` gives us a stable, script-friendly format
    // that includes the ahead/behind counts on the `## branch…remote` header
    // line without requiring a second `git rev-list` call.
    const statusOutput = execGit(cwd, ["status", "--porcelain=v1", "--branch"]);
    const parsed = parseGitStatus(statusOutput);

    const snapshot: GitSnapshot = {
      branch: fallbackBranch ?? parsed.branch,
      worktreeName,
      statusParts: formatGitStatus(parsed.counts),
      dirty: isDirty(parsed.counts),
      expiresAt: now + GIT_CACHE_TTL_MS,
    };

    evictAndSet(cwd, snapshot);
    return snapshot;
  } catch {
    // git is unavailable or the directory is not a repo – cache a minimal
    // sentinel so we don't hammer the process table on every render frame.
    const snapshot: GitSnapshot = {
      branch: fallbackBranch,
      dirty: false,
      expiresAt: now + GIT_CACHE_TTL_MS,
    };
    evictAndSet(cwd, snapshot);
    return snapshot;
  }
}

// ── Cache Management ─────────────────────────────────────────────────

/**
 * Write `snapshot` into the cache for `cwd`.
 *
 * Remove any existing entry for this cwd first so refreshing an existing key
 * never evicts an unrelated worktree just because the cache is full.  Then
 * sweep expired entries and, only if adding this new key would exceed the cap,
 * evict least-recently-used live entries until there is room.
 */
function evictAndSet(cwd: string, snapshot: GitSnapshot): void {
  gitCache.delete(cwd);
  sweepExpiredGitCache(Date.now());

  while (gitCache.size >= GIT_CACHE_MAX_SIZE) {
    const oldest = gitCache.keys().next().value;
    if (oldest === undefined) break;
    gitCache.delete(oldest);
  }

  gitCache.set(cwd, snapshot);
}

/** Move a cache hit to the back of the Map so eviction is LRU, not FIFO. */
function touchGitCacheEntry(cwd: string, snapshot: GitSnapshot): void {
  gitCache.delete(cwd);
  gitCache.set(cwd, snapshot);
}

function sweepExpiredGitCache(now: number): void {
  for (const [key, entry] of gitCache) {
    if (entry.expiresAt <= now) gitCache.delete(key);
  }
}

// ── Git Commands ─────────────────────────────────────────────────────

/**
 * Execute a git command in `cwd` and return trimmed stdout.
 * Stderr is suppressed; a non-zero exit or timeout throws automatically.
 */
function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_COMMAND_TIMEOUT_MS,
  }).trim();
}

/**
 * Detect whether `cwd` belongs to a *linked* git worktree (created via
 * `git worktree add`).  For a linked worktree the `.git` file inside the
 * worktree root points to a path under `.git/worktrees/<name>/`, so we check
 * for that directory structure to distinguish from the main worktree.
 *
 * Returns the basename of the worktree root (usually a descriptive folder
 * name the developer chose when running `git worktree add`), or `undefined`
 * for the main worktree or when git is unavailable.
 */
function getLinkedWorktreeName(cwd: string, worktreeRoot: string): string | undefined {
  try {
    const gitDir = execGit(cwd, ["rev-parse", "--absolute-git-dir"]);
    // Linked worktrees store their git state in `.git/worktrees/<name>/`
    if (basename(dirname(gitDir)) !== "worktrees") return undefined;
    return basename(worktreeRoot) || undefined;
  } catch {
    return undefined;
  }
}

// ── Status Parsing ───────────────────────────────────────────────────

/**
 * Parse the output of `git status --porcelain=v1 --branch` into a branch
 * name and a bag of file-status counts.
 *
 * Porcelain v1 format:
 *   - Line starting with `## ` → branch header (ahead/behind info included)
 *   - Line starting with `!!` → ignored file (skipped)
 *   - Line starting with `??` → untracked file
 *   - All other two-character XY status codes → staged (X) / working-tree (Y)
 */
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
      // Branch header – extract the local branch name and ahead/behind counts.
      branch = parseStatusBranch(line.slice(3));
      counts.ahead += Number(line.match(/ahead (\d+)/)?.[1] ?? 0);
      counts.behind += Number(line.match(/behind (\d+)/)?.[1] ?? 0);
      continue;
    }

    // XY status columns per POSIX git-status(1):
    //   X = staged change, Y = working-tree change
    const x = line[0];
    const y = line[1];
    const xy = `${x}${y}`;

    if (xy === "??") {
      counts.untracked += 1;
      continue;
    }
    // `!!` = ignored – not meaningful for the dirty indicator, skip entirely.
    if (xy === "!!") continue;

    // Merge/rebase conflict codes: both sides have independently modified the entry.
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) {
      counts.conflicted += 1;
      continue;
    }

    // Staged-index column (X): only count if there's an actual index change.
    if (x === "R" || x === "C") counts.renamed += 1;
    else if (x === "D") counts.deleted += 1;
    else if (x !== " ") counts.staged += 1;

    // Working-tree column (Y): captures unstaged modifications/deletions.
    if (y === "D") counts.deleted += 1;
    else if (y === "M" || y === "T") counts.modified += 1;
  }

  return { branch, counts };
}

/**
 * Extract the local branch name from the `## ` header produced by
 * `git status --porcelain=v1 --branch`.
 *
 * The header format is one of:
 *   - `HEAD (no branch)`              – detached HEAD
 *   - `<branch>`                      – local-only branch
 *   - `<branch>...<remote>[<ahead/behind>]`
 *
 * Returns `undefined` for detached HEAD so callers can fall back to the
 * session-provided branch name.
 */
function parseStatusBranch(header: string): string | undefined {
  // Strip the trailing `[ahead N, behind M]` annotation, then take the local
  // portion before the `...` upstream separator.
  const value = header.replace(/\s+\[[^\]]+\]$/, "").split("...")[0];
  // git uses "HEAD (no branch)" for detached HEAD state.
  if (!value || value.startsWith("HEAD ")) return undefined;
  return value;
}

// ── Status Formatting ────────────────────────────────────────────────

/**
 * Convert raw status counts into a list of coloured symbol+count parts
 * suitable for the branch chip in the footer.
 * Returns `undefined` when the working tree is clean (no parts to display).
 */
function formatGitStatus(counts: GitStatusCounts): GitStatusPart[] | undefined {
  const parts = [
    formatGitStatusPart("=", counts.conflicted, COLOR.contextRed),   // merge conflicts
    formatGitStatusPart("⇡", counts.ahead,      COLOR.gitStaged),    // commits ahead of remote
    formatGitStatusPart("⇣", counts.behind,     COLOR.gitDeleted),   // commits behind remote
    formatGitStatusPart("✘", counts.untracked,  COLOR.gitUntracked), // untracked files
    formatGitStatusPart("~", counts.modified,   COLOR.gitModified),  // modified files
    formatGitStatusPart("+", counts.staged,     COLOR.gitStaged),    // staged changes
    formatGitStatusPart("»", counts.renamed,    COLOR.gitRenamed),   // renames/copies
    formatGitStatusPart("-", counts.deleted,    COLOR.gitDeleted),   // deleted files
  ].filter((part): part is GitStatusPart => part !== undefined);

  return parts.length > 0 ? parts : undefined;
}

/**
 * Build a single {@link GitStatusPart} only when `count > 0`, so callers can
 * simply filter out the `undefined` values rather than gating every push.
 */
function formatGitStatusPart(symbol: string, count: number, color: string): GitStatusPart | undefined {
  return count > 0 ? { symbol, count, color } : undefined;
}

/**
 * Return `true` if there are any local changes that should light up the
 * dirty indicator on the branch chip (ahead/behind are intentionally
 * excluded – they don't affect the working tree cleanliness).
 */
function isDirty(counts: GitStatusCounts): boolean {
  return counts.conflicted + counts.modified + counts.untracked + counts.staged + counts.renamed + counts.deleted > 0;
}
