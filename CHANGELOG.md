# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Replaced the static `MODEL` chip label with the active model provider.
- Moved the `CTX` chip to the start of the second row's right side.

## [0.3.0] - 2026-06-24

### Added

- **Progressive Reset Countdown Display**: Replaced static 5-hour and weekly status labels with dynamic countdowns.
  - The 5-hour window shows hours normally (e.g., `4h`) and minutes when under 1 hour (e.g., `37m`).
  - The weekly window shows days normally (e.g., `5d`), hours when under 1 day (e.g., `12h`), and minutes when under 1 hour.
  - Automatically falls back to old labels if the reset time is unavailable.

### Fixed

- **Restored Custom Font Symbols**: Restored custom status-line font symbols to improve visual styling:
  - Chip separators (``, ``, ``) in `src/chips.ts`.
  - Path icon (``) and git branch icon (``) in `src/renderers.ts`.
- **`scheduleRefresh` Timer Drift**: Fixed `scheduleRefresh` in `src/codex-usage/manager.ts` by anchoring the refresh interval to `cache.createdAt`. This prevents caching periods from being extended indefinitely upon external status updates.
- **`scheduleRefresh` Retry Loop**: Implemented exponential backoff for retrying failed Codex usage updates (1m → 2m → 4m → capped at 5m) and eliminated the 0ms retry loop on stale caches.
- **Unbounded Git Cache Growth**: Replaced the unbounded FIFO cache in `src/git.ts` with a proper Least Recently Used (LRU) cache capped at `GIT_CACHE_MAX_SIZE`. It now touches entries on hits, deletes existing keys before updating, sweeps expired entries on every write, and limits eviction to new insertions.

### Changed

- **Branding Update**: Renamed `CODEX` label and references to `OpenAI` and updated the corresponding color palette and display logic.

### Documentation

- Added inline documentation comments throughout `src/` files to detail system layout, rendering paths, and data flows.

---

## [0.2.0] - 2026-06-06

### Performance

- **TUI Redraw Optimizations**:
  - Cached footer render output by width and `renderVersion` so that standard keystroke redraws do not trigger full infobar recomputations.
  - Moved heavy synchronous routines (`getTokenTotals` and `contextSnapshot`) out of the main `render()` cycle to prevent performance hiccups.
  - Stats are now updated only on critical lifecycle events (session start, turn end, model selection, git branch changes, timer tick).

---

## [0.1.1] - 2026-06-06

### Changed

- Updated the repository extension banner image URL in `package.json` to point to the raw GitHub resource URL for correct rendering in extension lists.

---

## [0.1.0] - 2026-06-06

### Added

- **Initial Release**: High-contrast, two-row info bar inspired by Starship-style terminal statuslines.
  - Line 1: working directory path, git worktree and branch info, active model, thinking effort level, and context usage percent.
  - Line 2: Codex subscription usage, token usage rates, and estimated session cost.
  - CLI control via `/pi-infobar` and `/codex-status` commands.
