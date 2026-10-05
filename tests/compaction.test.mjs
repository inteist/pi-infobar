import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let buildDir;
let piInfobar;
let CodexUsageManager;
let CursorUsageManager;
let stripAnsi;
let contextSnapshot;
let testSdk;
let queryUsage;

// Exercise the real extension and renderers without adding a TS test runner.
before(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "pi-infobar-test-"));
  writeFileSync(join(buildDir, "package.json"), '{"type":"module"}');
  const scope = join(buildDir, "node_modules", "@earendil-works");
  const sdkDir = join(scope, "pi-coding-agent");
  mkdirSync(sdkDir, { recursive: true });
  symlinkSync(join(root, "node_modules/@earendil-works/pi-tui"), join(scope, "pi-tui"), "dir");

  // Delegate to the installed SDK by default, but allow individual tests to
  // stub its helpers without experimental Node module-mocking flags.
  const sdkUrl = JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"));
  writeFileSync(join(sdkDir, "package.json"), '{"type":"module","exports":"./index.mjs"}');
  writeFileSync(join(sdkDir, "index.mjs"), `
    import * as sdk from ${sdkUrl};
    export * from ${sdkUrl};
    export const testSdk = {
      buildSessionProjection: sdk.buildSessionProjection,
      estimateTokens: sdk.estimateTokens,
      getLatestCompactionEntry: sdk.getLatestCompactionEntry,
    };
    export const buildSessionProjection = (...args) => testSdk.buildSessionProjection(...args);
    export const estimateTokens = (...args) => testSdk.estimateTokens(...args);
    export const getLatestCompactionEntry = (...args) => testSdk.getLatestCompactionEntry(...args);
  `);
  const build = spawnSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--project", join(root, "tsconfig.json"),
    "--noEmit", "false",
    "--outDir", buildDir,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);

  const load = (path) => import(pathToFileURL(join(buildDir, path)).href);
  ({ default: piInfobar } = await load("src/index.js"));
  ({ CodexUsageManager } = await load("src/codex-usage/manager.js"));
  ({ CursorUsageManager } = await load("src/cursor-usage/manager.js"));
  ({ queryUsage } = await load("src/codex-usage/query.js"));
  ({ stripAnsi } = await load("src/ansi.js"));
  ({ contextSnapshot } = await load("src/format.js"));
  ({ testSdk } = await load("node_modules/@earendil-works/pi-coding-agent/index.mjs"));
});

after(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

function createHarness(t) {
  t.mock.method(CodexUsageManager.prototype, "refresh", async () => {});
  t.mock.method(CursorUsageManager.prototype, "refresh", async () => {});
  const oldEnabled = process.env.PI_INFOBAR;
  process.env.PI_INFOBAR = "1";
  t.after(() => {
    if (oldEnabled === undefined) delete process.env.PI_INFOBAR;
    else process.env.PI_INFOBAR = oldEnabled;
  });

  const handlers = new Map();
  let footer;
  let renderRequests = 0;
  let usage = { tokens: 647_298, contextWindow: 1_048_576, percent: 62 };
  let systemPrompt = "p".repeat(400);
  const branch = [
    {
      type: "message", id: "old", parentId: null,
      timestamp: "2026-06-24T11:59:00Z",
      message: { role: "user", content: "x".repeat(2_000_000), timestamp: 0 },
    },
    {
      type: "message", id: "assistant", parentId: "old",
      timestamp: "2026-06-24T12:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        usage: {
          input: 647_298, output: 300, cacheRead: 0, cacheWrite: 0,
          cost: { total: 1.25 },
        },
      },
    },
    {
      type: "message", id: "kept", parentId: "assistant",
      timestamp: "2026-06-24T12:01:00Z",
      message: { role: "user", content: "k".repeat(40_000), timestamp: 0 },
    },
  ];
  const ctx = {
    mode: "tui",
    cwd: buildDir,
    model: { id: "test-model", provider: "test" },
    getContextUsage: () => usage,
    getSystemPrompt: () => systemPrompt,
    sessionManager: {
      getBranch: () => branch,
      buildSessionProjection: () => testSdk.buildSessionProjection(branch),
    },
    ui: {
      setStatus() {},
      setFooter(factory) {
        footer?.dispose();
        footer = factory?.(
          { requestRender() { renderRequests += 1; } },
          {},
          { getGitBranch: () => undefined, onBranchChange: () => () => {} },
        );
      },
    },
  };

  piInfobar({
    getThinkingLevel: () => "off",
    registerCommand() {},
    on: (name, handler) => handlers.set(name, handler),
  });
  const emit = async (name, event = {}) => {
    assert.ok(handlers.has(name), `Missing ${name} handler`);
    await handlers.get(name)(event, ctx);
  };
  t.after(() => emit("session_shutdown"));

  return {
    emit,
    branch,
    ctx,
    setUsage: (value) => { usage = value; },
    setSystemPrompt: (value) => { systemPrompt = value; },
    appendCompaction: (summary = "s".repeat(80_000)) => {
      const entry = {
        type: "compaction", id: `compact-${branch.length}`,
        parentId: branch.at(-1).id,
        timestamp: "2026-06-24T12:02:00Z",
        summary, firstKeptEntryId: "kept", tokensBefore: 647_298,
        systemMessage: { role: "system", content: systemPrompt, timestamp: 0 },
      };
      branch.push(entry);
      return entry;
    },
    snapshot: () => contextSnapshot(ctx),
    usageLine: () => stripAnsi(footer.render(240).at(-1)),
    renderRequests: () => renderRequests,
  };
}

test("compaction refresh ignores event metadata and the next turn restores reported usage", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start");
  const before = harness.usageLine();
  assert.match(before, /CTX.*62%/);
  const renderRequests = harness.renderRequests();

  harness.appendCompaction();
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  const unreadableEvent = new Proxy({}, {
    get() { throw new Error("The handler must not read compaction event metadata"); },
  });
  await harness.emit("session_compact", unreadableEvent);
  const compacted = harness.usageLine();
  // 20k summary + 10k retained user message + 100 prompt tokens, not old history.
  assert.match(compacted, /CTX.*~3%/);
  assert.doesNotMatch(compacted, /62%/);
  assert.ok(harness.renderRequests() > renderRequests, "Compaction must request a redraw");
  // Usage and cost are cumulative; only the current context meter resets.
  assert.equal(
    compacted.replace(/\s+/g, " "),
    before.replace("62%", "~3%").replace(/\s+/g, " "),
  );

  harness.setUsage({ tokens: 73_400, contextWindow: 1_048_576, percent: 7 });
  await harness.emit("turn_end");
  assert.match(harness.usageLine(), /CTX.*7%/);
  assert.doesNotMatch(harness.usageLine(), /CTX.*~7%/);
});

test("compaction uses a fresh numeric reading when the host provides one", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start");
  assert.match(harness.usageLine(), /CTX.*62%/);

  const compactionEntry = harness.appendCompaction();
  harness.setUsage({ tokens: 41_943, contextWindow: 1_048_576, percent: 4 });
  await harness.emit("session_compact", { fromExtension: false, compactionEntry });
  assert.match(harness.usageLine(), /CTX.*4%/);
  assert.doesNotMatch(harness.usageLine(), /CTX.*~4%/);
});

test("resuming a compacted session restores an estimate without a compaction event", async (t) => {
  const harness = createHarness(t);
  harness.appendCompaction();
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  await harness.emit("session_start");
  assert.match(harness.usageLine(), /CTX.*~3%/);
});

test("repeated compaction estimates only the newest summary and retained messages", async (t) => {
  const harness = createHarness(t);
  harness.appendCompaction();
  harness.appendCompaction("n".repeat(40_000));
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  assert.equal(harness.snapshot().label, "~2%");
});

test("a projected system checkpoint is counted once without reading the prompt again", (t) => {
  const harness = createHarness(t);
  harness.setSystemPrompt("p".repeat(100_000));
  harness.appendCompaction();
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  t.mock.method(harness.ctx, "getSystemPrompt", () => {
    throw new Error("Projected system prompts must not be counted a second time");
  });
  assert.equal(harness.snapshot().label, "~5%");
});

test("the estimate includes the effective system prompt", (t) => {
  const harness = createHarness(t);
  harness.setSystemPrompt("p".repeat(100_000));
  harness.appendCompaction();
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  assert.equal(harness.snapshot().label, "~5%");
});

test("projected tool definitions contribute to the estimate", (t) => {
  const harness = createHarness(t);
  const compaction = harness.appendCompaction();
  compaction.systemMessage.toolsAdded = [{
    name: "large-tool", description: "t".repeat(100_000), parameters: { type: "object" },
  }];
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  assert.equal(harness.snapshot().label, "~5%");
});

for (const [name, replacement, expected] of [
  ["omissions", null, "~2%"],
  ["replacements", { content: "r".repeat(4_000) }, "~2%"],
]) {
  test(`persisted context-edit ${name} are reflected in the estimate`, (t) => {
    const harness = createHarness(t);
    const compaction = harness.appendCompaction();
    harness.branch.push({
      type: "context_edit", id: "edit", parentId: compaction.id,
      timestamp: "2026-06-24T12:03:00Z", targetId: "kept", replacement,
    });
    harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
    assert.equal(harness.snapshot().label, expected);
  });
}

test("retained assistants contribute message content, not pre-compaction usage", (t) => {
  const harness = createHarness(t);
  harness.appendCompaction().firstKeptEntryId = "assistant";
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  assert.equal(harness.snapshot().label, "~3%");
});

test("estimated percentages use the same color ramp as reported usage", (t) => {
  const harness = createHarness(t);
  harness.appendCompaction();
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  const estimate = harness.snapshot();
  harness.setUsage({ tokens: 30_100, contextWindow: 1_048_576, percent: 30_100 / 1_048_576 * 100 });
  const reported = harness.snapshot();
  assert.equal(estimate.label, `~${reported.label}`);
  assert.equal(estimate.color, reported.color);
});

test("estimates use the host context window and clamp over-capacity readings", (t) => {
  const harness = createHarness(t);
  harness.appendCompaction();
  harness.setUsage({ tokens: null, contextWindow: 100_000, percent: null });
  assert.equal(harness.snapshot().label, "~30%");
  harness.setUsage({ tokens: null, contextWindow: 10_000, percent: null });
  assert.equal(harness.snapshot().label, "~100%");
});

test("non-finite reported percentages fall back to the compacted estimate", (t) => {
  const harness = createHarness(t);
  harness.appendCompaction();
  for (const percent of [NaN, Infinity, -Infinity]) {
    harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent });
    assert.equal(harness.snapshot().label, "~3%");
  }
});

test("unknown usage before any compaction remains unknown", (t) => {
  const harness = createHarness(t);
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  assert.equal(harness.snapshot().label, "?");
});

test("malformed retained assistant content falls back to unknown", (t) => {
  const harness = createHarness(t);
  harness.appendCompaction().firstKeptEntryId = "assistant";
  harness.branch[1].message.content = {};
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  assert.equal(harness.snapshot().label, "?");
});

for (const helper of ["getLatestCompactionEntry", "buildSessionProjection", "estimateTokens"]) {
  test(`${helper} failures do not interrupt the compaction redraw`, async (t) => {
    const harness = createHarness(t);
    await harness.emit("session_start");
    harness.appendCompaction();
    harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
    t.mock.method(testSdk, helper, () => { throw new Error("SDK failure"); });
    const renderRequests = harness.renderRequests();
    await harness.emit("session_compact");
    assert.match(harness.usageLine(), /CTX.*\?/);
    assert.ok(harness.renderRequests() > renderRequests);
  });
}

test("session history failures fall back to unknown", (t) => {
  const harness = createHarness(t);
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  t.mock.method(harness.ctx.sessionManager, "getBranch", () => { throw new Error("History unavailable"); });
  assert.equal(harness.snapshot().label, "?");
});

test("non-finite token estimates fall back to the same unknown snapshot", (t) => {
  const harness = createHarness(t);
  harness.appendCompaction();
  harness.setUsage({ tokens: null, contextWindow: 1_048_576, percent: null });
  let tokens = NaN;
  t.mock.method(testSdk, "estimateTokens", () => tokens);
  const unknown = harness.snapshot();
  assert.equal(unknown.label, "?");
  tokens = Infinity;
  assert.equal(harness.snapshot(), unknown);
});

test("reported zero usage is preserved without attempting estimation", (t) => {
  const harness = createHarness(t);
  harness.appendCompaction();
  harness.setUsage({ tokens: 0, contextWindow: 1_048_576, percent: 0 });
  t.mock.method(testSdk, "buildSessionProjection", () => { throw new Error("Unexpected estimate"); });
  assert.equal(harness.snapshot().label, "0%");
});

test("Codex usage requests omit null headers returned by the Pi 1.0 auth API", async (t) => {
  const harness = createHarness(t);
  harness.ctx.model = { provider: "openai-codex", id: "test-model" };
  harness.ctx.modelRegistry = {
    getAvailable: () => [],
    getAll: () => [],
    getApiKeyAndHeaders: async () => ({
      ok: true, apiKey: "test-token",
      headers: { Authorization: "Bearer test-token", "X-Removed": null, "X-Kept": "yes" },
    }),
  };
  let headers;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    headers = init.headers;
    return new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
    }), { status: 200 });
  });
  const result = await queryUsage(harness.ctx, { timeoutMs: 1_000 });
  assert.equal(result.ok, true);
  assert.equal(headers["X-Kept"], "yes");
  assert.equal(headers.Authorization, "Bearer test-token");
  assert.ok(!("X-Removed" in headers));
});

test("unavailable or invalid context windows remain unknown", (t) => {
  const harness = createHarness(t);
  harness.appendCompaction();
  for (const contextWindow of [0, -1, NaN, Infinity]) {
    harness.setUsage({ tokens: null, contextWindow, percent: null });
    assert.equal(harness.snapshot().label, "?");
  }
  harness.setUsage(undefined);
  assert.equal(harness.snapshot().label, "?");
});
