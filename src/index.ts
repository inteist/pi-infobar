import process from "node:process";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  CodexUsageManager,
  formatQueryErrors,
  isOpenAICodexModel,
  parseCodexStatusArgs,
  queryUsage,
  showCodexReport,
} from "./codex-usage/index.js";
import {
  contextSnapshot,
  getTokenTotals,
} from "./format.js";
import {
  renderPrimaryLine,
  renderSeparatorLine,
  renderUsageLine,
} from "./renderers.js";
import type { RuntimeState } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────

/** Key used to register/clear the status-line entry for the infobar.
 *  Must be unique across all extensions writing to the status area. */
const FOOTER_KEY = "pi-infobar";

/** Slash-command name for the Codex usage query. */
const CODEX_COMMAND_NAME = "codex-status";

// ── Extension Entry Point ────────────────────────────────────────────

/**
 * Main extension entry point called once by Pi when the extension is loaded.
 *
 * Sets up:
 *  - Shared mutable `runtime` state bag shared by all renderers.
 *  - The `/pi-infobar` toggle command.
 *  - The `/codex-status` query command.
 *  - Session lifecycle event listeners that keep the footer in sync.
 *
 * The `enabled` flag is read from the `PI_INFOBAR` env variable at startup
 * (set to "0" to disable by default) and can be toggled at runtime via the
 * `/pi-infobar` command.
 */
export default function piInfobar(pi: ExtensionAPI): void {
  let enabled = process.env.PI_INFOBAR !== "0";
  const codexUsage = new CodexUsageManager();

  /**
   * Mutable state shared between the event handlers and the render closures.
   * Kept as a single object so render functions can hold a stable reference
   * without needing to re-subscribe when values change.
   */
  const runtime: RuntimeState = {
    thinkingLevel: "off",
    renderVersion: 0,
    context: { label: "?", color: "" },
    tokenTotals: { input: 0, output: 0, cost: 0 },
    codexUsage,
  };

  // ── Internal Helpers ──────────────────────────────────────────────

  /** Snapshot the current context usage and token totals into `runtime`. */
  const updateFooterStats = (ctx: ExtensionContext) => {
    runtime.context = contextSnapshot(ctx);
    runtime.tokenTotals = getTokenTotals(ctx);
  };

  /**
   * Bump the render version counter and request a TUI redraw.
   * The version counter is the memoisation key used by the footer `render()`
   * method to skip redundant work when width and data haven't changed.
   */
  const refresh = () => {
    runtime.renderVersion += 1;
    runtime.requestRender?.();
  };

  /** Update stats and immediately trigger a redraw. */
  const refreshStats = (ctx: ExtensionContext) => {
    updateFooterStats(ctx);
    refresh();
  };

  /**
   * Kick off a background Codex usage refresh if the infobar is enabled.
   *
   * `force` bypasses the cache TTL check (used when the user explicitly runs
   * `/codex-status --refresh`).
   *
   * `model` defaults to the context's active model but can be overridden when
   * the refresh is triggered by a `model_select` event (the event carries the
   * newly selected model before the context has been fully updated).
   */
  const refreshCodexUsage = (
    ctx: ExtensionContext,
    force = false,
    model = ctx.model,
  ) => {
    if (!enabled) return;
    void codexUsage.refresh(ctx, force, model, {
      showErrors: isOpenAICodexModel(model),
    });
  };

  // ── Footer Installation ───────────────────────────────────────────

  /**
   * Install (or uninstall) the infobar footer for the given context.
   *
   * Only the `tui` mode surfaces a footer; in headless / non-TUI modes the
   * method is a no-op.  Calling this while already installed tears down the
   * old instance before creating a new one (Pi replaces the old setFooter call).
   *
   * When `enabled` is false the footer is removed and all associated
   * subscriptions are cleaned up.
   *
   * The footer closure captures:
   *  - A per-instance `cachedWidth` + `cachedVersion` pair for cheap
   *    memoisation – avoids re-rendering every frame when nothing changed.
   *  - `runtime.requestRender` set to the TUI's render request function so
   *    async state changes (e.g. Codex usage fetched) can push a redraw.
   *  - A 60-second clock interval that refreshes the reset-countdown timers
   *    in the usage chip without waiting for an external event.
   */
  const installFooter = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;

    // Clear any existing statusline entry before toggling.
    ctx.ui.setStatus(FOOTER_KEY, undefined);

    if (!enabled) {
      ctx.ui.setFooter(undefined);
      runtime.requestRender = undefined;
      codexUsage.setRenderCallback(undefined);
      codexUsage.clear();
      return;
    }

    ctx.ui.setFooter((tui, _theme, footerData) => {
      // Per-instance memoisation state: skip re-rendering when neither the
      // terminal width nor the runtime version has changed since last render.
      let cachedWidth = -1;
      let cachedVersion = -1;
      let cachedLines: string[] = [""];

      // Wire up async render triggers.
      runtime.requestRender = () => tui.requestRender();
      codexUsage.setRenderCallback(refresh);

      // Redraw whenever the git branch changes (e.g. after `git checkout`).
      const unsubscribeBranch = footerData.onBranchChange(refresh);

      // Periodic clock tick so reset-countdown labels stay accurate.
      const clock = setInterval(refresh, 60_000);

      return {
        /** Clean up subscriptions and intervals when the footer is torn down. */
        dispose() {
          unsubscribeBranch();
          clearInterval(clock);
          codexUsage.setRenderCallback(undefined);
        },

        /**
         * Invalidate the memoised output, e.g. when theme or palette changes.
         * Pi calls this before the next `render()` when a forced invalidation
         * is needed without a version bump.
         */
        invalidate() {
          cachedWidth = -1;
          cachedVersion = -1;
        },

        /**
         * Render the four-line footer for the current terminal `width`.
         *
         * Lines:
         *   1. Separator (thin rule)
         *   2. Primary line  – path + branch + provider/model + thinking chips
         *   3. Spacer        – blank separator for visual breathing room
         *   4. Usage line    – Codex usage chip + context + token counts + cost
         *
         * Memoised: if both `width` and `runtime.renderVersion` are unchanged
         * from the previous call, the cached string array is returned directly.
         */
        render(width: number): string[] {
          if (width <= 0) return [""];
          if (cachedWidth === width && cachedVersion === runtime.renderVersion) {
            return cachedLines;
          }

          cachedLines = [
            renderSeparatorLine(width),
            renderPrimaryLine(width, ctx, footerData, runtime),
            renderSeparatorLine(width, " "),
            renderUsageLine(width, ctx, footerData, runtime),
          ];
          cachedWidth = width;
          cachedVersion = runtime.renderVersion;
          return cachedLines;
        },
      };
    });
  };

  // ── Commands ─────────────────────────────────────────────────────

  /**
   * `/pi-infobar [on|off|toggle]`
   *
   * Toggle the high-contrast Pi info bar.  When enabling, immediately syncs
   * stats and triggers a Codex usage fetch so the footer is populated right
   * away rather than showing a stale or empty state.
   */
  pi.registerCommand("pi-infobar", {
    description:
      "Toggle the high-contrast Pi info bar. Usage: /pi-infobar [on|off|toggle]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else enabled = !enabled;

      if (enabled) updateFooterStats(ctx);
      installFooter(ctx);
      if (enabled) refreshCodexUsage(ctx);
      else codexUsage.clear();
      ctx.ui.notify(
        `High-contrast info bar ${enabled ? "enabled" : "disabled"}`,
        "info",
      );
    },
  });

  /**
   * `/codex-status [--refresh] [--no-statusline] [--clear-statusline] [--timeout <seconds>]`
   *
   * Query and display the current OpenAI Codex subscription usage.
   *
   * Behaviour matrix:
   *  - `--clear-statusline` → clear the footer chip and return early.
   *  - Cache fresh + no `--refresh` → show cached data immediately (no fetch).
   *  - Otherwise → fetch from Pi auth or Codex app-server and display results.
   *  - If `--statusline` (default) and infobar is enabled → push the fetched
   *    report into the footer chip for persistent display.
   */
  pi.registerCommand(CODEX_COMMAND_NAME, {
    description: "Show Codex ChatGPT subscription usage and rate-limit windows",
    handler: async (args, ctx) => {
      const options = parseCodexStatusArgs(args);
      if (!options.ok) {
        ctx.ui.notify(options.error, "warning");
        return;
      }

      if (options.value.clearStatusline) {
        codexUsage.clear();
        ctx.ui.notify("Codex usage cleared.", "info");
        return;
      }

      // Serve from cache when it is still fresh and the user didn't force a refresh.
      const cached = codexUsage.getReport();
      if (cached && codexUsage.isCacheFresh() && !options.value.refresh) {
        showCodexReport(ctx, cached, true);
        return;
      }

      try {
        const result = await queryUsage(ctx, options.value);
        if (!result.ok) {
          ctx.ui.notify(formatQueryErrors(result.errors), "error");
          return;
        }

        showCodexReport(ctx, result.report, false);

        // Push the fresh report into the footer chip only when both the
        // statusline option is enabled and the infobar is currently active.
        if (options.value.statusline && enabled) {
          codexUsage.setReport(result.report, ctx);
        }
      } catch (error) {
        ctx.ui.notify(
          `Codex usage query failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // ── Event Handlers ───────────────────────────────────────────────

  /**
   * `session_start` – a new Pi session has been created.
   * Snapshot the initial thinking level (it won't fire a separate event),
   * populate the footer stats, install the footer, and kick off an
   * initial Codex usage fetch.
   */
  pi.on("session_start", (_event, ctx) => {
    runtime.thinkingLevel = pi.getThinkingLevel();
    updateFooterStats(ctx);
    installFooter(ctx);
    refresh();
    refreshCodexUsage(ctx);
  });

  /**
   * `session_tree` – the session's conversation tree has been mutated
   * (e.g. a new turn was committed or the tree was pruned).
   * Re-install the footer in case the context mode changed, then refresh
   * stats and Codex usage.
   */
  pi.on("session_tree", (_event, ctx) => {
    installFooter(ctx);
    refreshStats(ctx);
    refreshCodexUsage(ctx);
  });

  /**
   * `session_shutdown` – the Pi session is closing.
   * Remove the footer and status entry, detach the render callback, and
   * dispose the Codex usage manager to cancel any pending timers.
   */
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(FOOTER_KEY, undefined);
    runtime.requestRender = undefined;
    codexUsage.clear();
    codexUsage.dispose();
  });

  /**
   * `model_select` – the user switched to a different model.
   * Refresh stats immediately and trigger a Codex usage refresh using the
   * newly selected model (passed via the event) so the chip updates before
   * the next timer tick.
   */
  pi.on("model_select", (event, ctx) => {
    refreshStats(ctx);
    refreshCodexUsage(ctx, false, event.model);
  });

  /** `agent_end` / `turn_end` – a turn completed; update token/cost totals. */
  pi.on("agent_end", (_event, ctx) => refreshStats(ctx));
  pi.on("turn_end", (_event, ctx) => refreshStats(ctx));

  /**
   * `thinking_level_select` – the user changed the thinking budget.
   * Update the chip label and request a redraw without a full stats refresh.
   */
  pi.on("thinking_level_select", (event) => {
    runtime.thinkingLevel = event.level;
    refresh();
  });
}
