import { execFile } from "node:child_process";

import type { PullRequestInfo } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────

/** How long a lookup result (including "no pull request") stays valid. */
const PR_CACHE_TTL_MS = 60_000;

/** How long to wait before looking for `gh` again when it is not installed. */
const PR_GH_MISSING_TTL_MS = 10 * 60_000;

/** Maximum time to wait for `gh`, which calls the GitHub API over the network. */
const PR_COMMAND_TIMEOUT_MS = 10_000;

// ── Cache ────────────────────────────────────────────────────────────

interface PullRequestEntry {
  pr?: PullRequestInfo;
  expiresAt: number;
  pending: boolean;
}

/**
 * Cache of the pull request for each cwd + branch pair.
 *
 * `get()` never blocks the synchronous footer render: it returns the last
 * known value and, when the entry is missing or expired, starts a background
 * `gh pr view` lookup.  `onUpdate` is called when a lookup settles so the
 * footer can redraw with the new value.
 *
 * A failed lookup keeps the last known pull request: GitHub keeps closed and
 * merged pull requests, so a known one stays correct, and a network error or
 * timeout must not hide it.  Without one, any `gh` failure (not installed, not
 * authenticated, not a GitHub repo, no pull request for the branch) is cached
 * as "no pull request".
 *
 * Entries are never evicted: a session visits few branches, and a kept entry
 * shows its pull request at once when you switch back to the branch.
 */
export class PullRequestCache {
  private readonly entries = new Map<string, PullRequestEntry>();

  constructor(private readonly onUpdate: () => void) {}

  get(cwd: string, branch: string): PullRequestInfo | undefined {
    const key = `${cwd}\n${branch}`;
    const entry = this.entries.get(key);
    if (!entry || (!entry.pending && entry.expiresAt <= Date.now())) {
      this.load(key, cwd, entry?.pr);
    }
    return entry?.pr;
  }

  private load(key: string, cwd: string, previous?: PullRequestInfo): void {
    // Keep showing the previous value while the refresh is in flight.
    this.entries.set(key, { pr: previous, expiresAt: 0, pending: true });

    // Without a selector, `gh` resolves the current branch's push target, so
    // fork branches and `gh pr checkout` branches find their pull request too.
    execFile(
      "gh",
      ["pr", "view", "--json", "number,state,isDraft"],
      { cwd, encoding: "utf8", timeout: PR_COMMAND_TIMEOUT_MS },
      (error, stdout) => {
        const ttl = error?.code === "ENOENT" ? PR_GH_MISSING_TTL_MS : PR_CACHE_TTL_MS;
        this.entries.set(key, {
          pr: (error ? undefined : parsePullRequest(stdout)) ?? previous,
          expiresAt: Date.now() + ttl,
          pending: false,
        });
        this.onUpdate();
      },
    );
  }
}

// ── Parsing ──────────────────────────────────────────────────────────

/** Parse `gh pr view --json number,state,isDraft` output. */
function parsePullRequest(stdout: string): PullRequestInfo | undefined {
  try {
    const data = JSON.parse(stdout) as { number?: unknown; state?: unknown; isDraft?: unknown };
    if (typeof data.number !== "number") return undefined;
    if (data.state === "MERGED") return { number: data.number, state: "merged" };
    if (data.state === "CLOSED") return { number: data.number, state: "closed" };
    return { number: data.number, state: data.isDraft === true ? "draft" : "open" };
  } catch {
    return undefined;
  }
}
