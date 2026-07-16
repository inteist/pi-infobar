![pi-infobar banner](./pi-infobar.png)

# pi-infobar - Pi Coding Agent Extension

High-contrast two-row info bar for the Pi coding agent.

This extension replaces Pi's default footer with a cleaner info bar layout inspired by a Starship-style prompt. It keeps the most important information visually dominant and avoids low-value activity labels like `status`, `idle`, or `ready`.

## Install

```bash
pi install npm:pi-infobar
```

Try it without installing permanently:

```bash
pi -e npm:pi-infobar
```

## Layout

### Line 1 — navigation + model state

#### Left:

- current working folder, rendered first and styled as the primary segment;
- linked worktree name with `󰙅`, when the current folder is a Git worktree;
- git branch, when available, with Starship-style git status inline (`~` modified blue, `✘` untracked red, `+` staged green, `-` deleted red, `⇡/⇣` ahead/behind).

The path segment stays as the normal path. Linked worktrees get a separate green worktree segment using the worktree root folder name.

#### Right:

- active model in light blue, labeled with its provider;
- thinking level with effort-specific color.

A subtle separator sits between the two information rows.

### Line 2

#### Left: Codex subscription usage

#### Right: context, token usage, and cost

- context percentage, first, with a stepped color ramp from transparent/green through yellow, orange, and red by 60%;
- `↑` tokens sent;
- `↓` tokens received;
- dark-green `$` estimated cost.

## Commands

```text
/pi-infobar            toggle the info bar
/pi-infobar on         enable
/pi-infobar off        disable
/pi-infobar toggle     toggle
/codex-status          show Codex usage and rate-limit windows
/codex-status --refresh  refresh Codex usage
/codex-status --no-statusline  show report without updating footer
/codex-status --clear-statusline  clear Codex usage from footer
```

You can start Pi with the info bar disabled:

```bash
PI_INFOBAR=0 pi
```

---

## Implementation Details

## Structure

```
pi-infobar/
├── src/
│   ├── index.ts          ← Entry point: extension lifecycle only (~80 lines)
│   ├── types.ts          ← All shared interfaces & type aliases (~45 lines)
│   ├── theme.ts          ← COLOR palette + contextColor/thinkingColor/codexAccent (~75 lines)
│   ├── ansi.ts           ← Low-level ANSI helpers: ansi(), stripAnsi(), hexToRgb(), readableTextOn() (~55 lines)
│   ├── chips.ts          ← Chip factory + renderChip/renderChips/renderSegmentedChip (~85 lines)
│   ├── format.ts         ← Pure data formatters: formatCount, formatCost, shortenModel, etc. (~80 lines)
│   ├── git.ts            ← Git snapshot, cache, parsing, status formatting (~175 lines)
│   ├── codex-usage/      ← Codex subscription usage queries, reports, cache, and statusline manager
│   └── renderers.ts      ← Footer line renderers: renderPrimaryLine, renderUsageLine, etc. (~140 lines)
├── index.ts              ← Re-export barrel: `export { default } from "./src/index.js"` (~1 line)
├── package.json          ← Updated "files" list & tsconfig include
└── tsconfig.json         ← Updated include glob
```

## Code Overview

- The `COLOR` constant object
- `contextColor()` — percent → color mapping
- `thinkingColor()` — thinking level → color mapping
- `codexAccent()` — raw status string → accent color
- `codexPercentColor()` — codex percent → color

Low-level terminal rendering primitives:

- `ansi()` — apply fg/bg/bold SGR codes
- `stripAnsi()` — strip ANSI escape sequences
- `hexToRgb()` — hex string → RGB
- `rgbCode()` — RGB → SGR color code
- `readableTextOn()` — pick readable text color for a background

The chip UI component system:

- `chip()` factory
- `renderChip()`, `renderChips()`
- `renderSegmentedChip()`

Pure data formatting functions:

- `formatCount()`, `formatCost()`
- `shortenModel()`, `modelName()`
- `formatThinking()`
- `formatWorkingPath()`, `smartPathTruncate()`
- `shorten()`, `simplifyStatusText()`
- `formatCodexValue()`, `codexValueSegments()`
- `getTokenTotals()`

All git integration, fully self-contained:

- `gitCache`, `GIT_CACHE_TTL_MS`, `GIT_COMMAND_TIMEOUT_MS`
- `getGitSnapshot()`, `execGit()`, `getLinkedWorktreeName()`
- `parseGitStatus()`, `parseStatusBranch()`
- `formatGitStatus()`, `formatGitStatusPart()`, `isDirty()`

Footer line renderers that compose chips, git, and formatting:

- `renderPrimaryLine()`, `renderUsageLine()`, `renderSeparatorLine()`
- `fitLeftRight()`
- `renderPathCluster()`, `renderPathChip()`, `renderFittedPathChip()`
- `renderBranchChip()`, `renderWorktreeChip()`
- `renderCodexStatus()`

The main extension entry point — only lifecycle & event wiring:

- `piInfobar()` default export
- `installFooter()`, `refresh()`
- Event handlers: `session_start`, `session_tree`, `session_shutdown`, `model_select`, `agent_end`, `turn_end`, `thinking_level_select`
- Command handlers: `pi-infobar`, `codex-status`

---
