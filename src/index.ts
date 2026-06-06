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

const FOOTER_KEY = "pi-infobar";
const CODEX_COMMAND_NAME = "codex-status";

// ── Extension Entry Point ────────────────────────────────────────────

export default function piInfobar(pi: ExtensionAPI): void {
  let enabled = process.env.PI_INFOBAR !== "0";
  const codexUsage = new CodexUsageManager();
  const runtime: RuntimeState = {
    thinkingLevel: "off",
    renderVersion: 0,
    context: { label: "?", color: "" },
    tokenTotals: { input: 0, output: 0, cost: 0 },
    codexUsage,
  };

  const updateFooterStats = (ctx: ExtensionContext) => {
    runtime.context = contextSnapshot(ctx);
    runtime.tokenTotals = getTokenTotals(ctx);
  };
  const refresh = () => {
    runtime.renderVersion += 1;
    runtime.requestRender?.();
  };
  const refreshStats = (ctx: ExtensionContext) => {
    updateFooterStats(ctx);
    refresh();
  };
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

  const installFooter = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setStatus(FOOTER_KEY, undefined);

    if (!enabled) {
      ctx.ui.setFooter(undefined);
      runtime.requestRender = undefined;
      codexUsage.setRenderCallback(undefined);
      codexUsage.clear();
      return;
    }

    ctx.ui.setFooter((tui, _theme, footerData) => {
      let cachedWidth = -1;
      let cachedVersion = -1;
      let cachedLines: string[] = [""];

      runtime.requestRender = () => tui.requestRender();
      codexUsage.setRenderCallback(refresh);
      const unsubscribeBranch = footerData.onBranchChange(refresh);
      const clock = setInterval(refresh, 60_000);

      return {
        dispose() {
          unsubscribeBranch();
          clearInterval(clock);
          codexUsage.setRenderCallback(undefined);
        },
        invalidate() {
          cachedWidth = -1;
          cachedVersion = -1;
        },
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

  pi.on("session_start", (_event, ctx) => {
    runtime.thinkingLevel = pi.getThinkingLevel();
    updateFooterStats(ctx);
    installFooter(ctx);
    refresh();
    refreshCodexUsage(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    installFooter(ctx);
    refreshStats(ctx);
    refreshCodexUsage(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(FOOTER_KEY, undefined);
    runtime.requestRender = undefined;
    codexUsage.clear();
    codexUsage.dispose();
  });

  pi.on("model_select", (event, ctx) => {
    refreshStats(ctx);
    refreshCodexUsage(ctx, false, event.model);
  });

  pi.on("agent_end", (_event, ctx) => refreshStats(ctx));
  pi.on("turn_end", (_event, ctx) => refreshStats(ctx));

  pi.on("thinking_level_select", (event) => {
    runtime.thinkingLevel = event.level;
    refresh();
  });
}
