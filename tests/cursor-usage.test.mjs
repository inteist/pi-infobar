import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
let buildDir, normalize, query, Manager, formatReport, renderUsageLine, stripAnsi, CodexManager, extension;
let credential;

before(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "pi-infobar-cursor-test-"));
  const compiled = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
    "--project", join(root, "tsconfig.json"), "--outDir", buildDir, "--noEmit", "false"], { cwd: root, encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  writeFileSync(join(buildDir, "package.json"), '{"type":"module"}');
  mkdirSync(join(buildDir, "node_modules/@earendil-works"), { recursive: true });
  symlinkSync(join(root, "node_modules/@earendil-works/pi-tui"), join(buildDir, "node_modules/@earendil-works/pi-tui"), "dir");
  const sdk = join(buildDir, "node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(sdk);
  writeFileSync(join(sdk, "package.json"), '{"type":"module","exports":"./index.js"}');
  const realSdk = pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
  writeFileSync(join(sdk, "index.js"), `export * from ${JSON.stringify(realSdk)};\nexport const readStoredCredential = (...args) => globalThis.__cursorTestCredential(...args);`);
  globalThis.__cursorTestCredential = (provider) => {
    assert.equal(provider, "cursor");
    return credential;
  };
  const load = (file) => import(pathToFileURL(join(buildDir, file)).href);
  ({ normalizeCursorUsage: normalize, queryCursorUsage: query } = await load("src/cursor-usage/query.js"));
  ({ CursorUsageManager: Manager } = await load("src/cursor-usage/manager.js"));
  ({ formatCursorUsageReport: formatReport } = await load("src/cursor-usage/index.js"));
  ({ CodexUsageManager: CodexManager } = await load("src/codex-usage/manager.js"));
  ({ renderUsageLine } = await load("src/renderers.js"));
  ({ stripAnsi } = await load("src/ansi.js"));
  ({ default: extension } = await load("src/index.js"));
});

after(() => {
  delete globalThis.__cursorTestCredential;
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

const payload = {
  planUsage: { totalPercentUsed: 9.032, autoPercentUsed: 10.528571428571428, apiPercentUsed: 1.175,
    includedSpend: 2000, limit: 2000 },
  spendLimitUsage: { limitType: "team", individualUsed: 0, pooledUsed: 999999 },
  billingCycleEnd: "1793290169000",
};
const ctx = (provider = "cursor") => ({ model: { provider, id: "test" }, modelRegistry: {}, ui: {} });
const success = () => ({ ok: true, report: normalize(payload, 123) });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function createCommandHarness(t) {
  const commands = new Map(), handlers = new Map(), notifications = [];
  t.mock.method(CodexManager.prototype, "refresh", async () => {});
  // Skip only the initial background request; subsequent requests use the real manager.
  const startupRefresh = t.mock.method(Manager.prototype, "refresh", async () => {});
  let manager, footer;
  const setter = Manager.prototype.setRenderCallback;
  t.mock.method(Manager.prototype, "setRenderCallback", function (...args) {
    manager = this;
    return setter.apply(this, args);
  });
  extension({
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => handlers.set(name, handler),
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 1, stdout: "" }),
  });
  const context = ctx();
  context.mode = "tui";
  context.cwd = dirname(root);
  context.getContextUsage = () => undefined;
  context.sessionManager = { getBranch: () => [], getSessionId: () => "cursor-test" };
  context.ui = {
    setStatus: () => {},
    setFooter: (factory) => {
      footer?.dispose();
      footer = factory?.({ requestRender: () => {} }, {}, { onBranchChange: () => () => {} });
    },
    notify: (message, level) => notifications.push({ message, level }),
  };
  handlers.get("session_start")({}, context);
  startupRefresh.mock.restore();
  credential = { type: "oauth", access: "command-access", expires: Date.now() + 600_000 };
  t.after(() => { footer?.dispose(); manager?.dispose(); });
  return {
    context, manager, notifications,
    command: (args) => commands.get("cursor-status").handler(args, context),
    event: (name, event = {}) => handlers.get(name)(event, context),
    toggle: (args) => commands.get("pi-infobar").handler(args, context),
  };
}

test("Cursor authoritative percentages override misleading legacy spend and pooled team usage", () => {
  const report = normalize(payload, 123);
  assert.equal(report.totalPercentUsed, 9.032);
  assert.equal(report.autoPercentUsed, 10.528571428571428);
  assert.equal(report.apiPercentUsed, 1.175);
  assert.equal(report.onDemandDollars, 0);
  assert.equal(report.billingCycleEnd, 1793290169000);
  assert.match(formatReport(report), /Included: 9% used \(91% left\)/);
  assert.match(formatReport(report), /Auto: 11% used/);
  assert.match(formatReport(report), /API: 1% used/);
  assert.match(formatReport(report), /On-Demand: \$0\.00/);
  assert.match(formatReport(report), /Resets Oct 29/);
});

test("zero percentage is authoritative; legacy ratio and personal cents are fallbacks", () => {
  assert.equal(normalize({ planUsage: { totalPercentUsed: 0, includedSpend: 100, limit: 100 } }).totalPercentUsed, 0);
  const report = normalize({ planUsage: { includedSpend: "250", limit: "1000" }, spendLimitUsage: { individualUsed: "1234" } });
  assert.equal(report.totalPercentUsed, 25);
  assert.equal(report.onDemandDollars, 12.34);
  assert.equal(report.autoPercentUsed, undefined);
});

test("unsupported plans and invalid numbers do not fabricate a remaining percentage", () => {
  const report = normalize({ billingCycleEnd: "1793290169000" });
  assert.equal(report.totalPercentUsed, undefined);
  assert.equal(report.autoPercentUsed, undefined);
  assert.match(formatReport(report), /Included: unavailable/);
  for (const value of [-1, "", "oops", Infinity, NaN, null, false]) {
    assert.equal(normalize({ planUsage: { totalPercentUsed: value, limit: 0, includedSpend: 0 } }).totalPercentUsed, undefined);
  }
  for (const bad of [null, [], "bad", {}]) assert.throws(() => normalize(bad), /Invalid Cursor usage response/);
  assert.equal(normalize({ planUsage: {}, billingCycleEnd: "1e50" }).billingCycleEnd, undefined);
});

test("usage query uses explicit Pi OAuth token, Connect JSON POST, and no sentinel API key", async (t) => {
  credential = { type: "oauth", access: "test-access-token", expires: Date.now() + 60_000 };
  const context = ctx("anthropic");
  context.modelRegistry.getProviderAuth = () => { throw new Error("should not refresh valid credentials"); };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
    assert.equal(options.method, "POST");
    assert.equal(options.body, "{}");
    assert.equal(options.headers.Authorization, "Bearer test-access-token");
    assert.equal(options.headers["Connect-Protocol-Version"], "1");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.redirect, "error");
    return Response.json(payload);
  });
  assert.equal((await query(context, { timeoutMs: 1000 })).ok, true);
});

test("expired OAuth is refreshed by Pi and then reread, not taken from the sentinel apiKey", async (t) => {
  credential = { type: "oauth", access: "expired", expires: 0 };
  const context = ctx();
  context.modelRegistry.getProviderAuth = async (provider) => {
    assert.equal(provider, "cursor");
    credential = { type: "oauth", access: "rotated-access", expires: Date.now() + 60_000 };
    return { ok: true, apiKey: "native-api-sentinel" };
  };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer rotated-access");
    return Response.json(payload);
  });
  assert.equal((await query(context, { timeoutMs: 1000 })).ok, true);
});

test("no Cursor login quietly skips fetch", async (t) => {
  credential = undefined;
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  const result = await query(ctx(), { timeoutMs: 1000 });
  assert.equal(result.unavailable, true);
  assert.equal(fetch.mock.callCount(), 0);
});

test("HTTP and auth errors never leak response bodies or tokens", async (t) => {
  credential = { type: "oauth", access: "sensitive-token", expires: Date.now() + 60_000 };
  t.mock.method(globalThis, "fetch", async () => new Response("sensitive-token account details", { status: 401 }));
  const result = await query(ctx(), { timeoutMs: 1000 });
  assert.match(result.error, /HTTP 401.*\/login/);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-token|account details/);
  credential.expires = 0;
  const context = ctx();
  context.modelRegistry.getProviderAuth = async () => { throw new Error("sensitive-token"); };
  assert.doesNotMatch(JSON.stringify(await query(context, { timeoutMs: 1000 })), /sensitive-token/);
});

test("timeout covers OAuth refresh as well as reading the response body", async (t) => {
  credential = { type: "oauth", access: "expired", expires: 0 };
  const context = ctx();
  context.modelRegistry.getProviderAuth = () => new Promise(() => {});
  assert.match((await query(context, { timeoutMs: 5 })).error, /timed out/);
  credential.expires = Date.now() + 60_000;
  t.mock.method(globalThis, "fetch", async (_url, options) => ({ ok: true, json: () => new Promise((_r, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }) }));
  assert.match((await query(context, { timeoutMs: 5 })).error, /timed out/);
});

test("manager deduplicates requests, caches for five minutes, and clears late results", async () => {
  let calls = 0;
  const d = deferred();
  const manager = new Manager(() => { calls++; return d.promise; });
  const p = manager.refresh(ctx());
  assert.equal(manager.state, "loading");
  assert.equal(manager.refresh(ctx()), p);
  assert.equal(calls, 1);
  d.resolve(success());
  await p;
  assert.equal(manager.state, "loaded");
  assert.equal(manager.isCacheFresh(), true);
  await manager.refresh(ctx());
  assert.equal(calls, 1);
  manager.dispose();
  const late = deferred();
  const next = new Manager(() => late.promise);
  const pending = next.refresh(ctx());
  next.clear();
  late.resolve(success());
  await pending;
  assert.equal(next.getReport(), undefined);
  assert.equal(next.state, "idle");
});

test("manager retries at 1m/2m/4m/5m, keeps stale data, and resets on success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const outcomes = [success(), ...Array(4).fill({ ok: false, error: "failed" }), success()];
  let calls = 0;
  const manager = new Manager(async () => { calls++; return outcomes.shift(); });
  await manager.refresh(ctx());
  t.mock.timers.tick(300_000);
  await manager.refresh(ctx());
  assert.equal(manager.state, "error");
  assert.equal(manager.getReport().totalPercentUsed, 9.032);
  for (const delay of [60_000, 120_000, 240_000, 300_000]) {
    const before = calls;
    t.mock.timers.tick(delay - 1);
    assert.equal(calls, before);
    t.mock.timers.tick(1);
    await manager.refresh(ctx());
    assert.equal(calls, before + 1);
  }
  assert.equal(manager.state, "loaded");
  manager.dispose();
});

test("forcing a refresh ignores the older response and aborts its signal", async () => {
  const first = deferred(), second = deferred();
  let calls = 0, oldSignal;
  const manager = new Manager((_ctx, options) => {
    if (++calls === 1) { oldSignal = options.signal; return first.promise; }
    return second.promise;
  });
  const p1 = manager.refresh(ctx());
  const p2 = manager.refresh(ctx(), true);
  assert.equal(oldSignal.aborted, true);
  second.resolve(success());
  await p2;
  first.resolve({ ok: true, report: normalize({ planUsage: { totalPercentUsed: 99 } }) });
  await p1;
  assert.equal(manager.getReport().totalPercentUsed, 9.032);
  manager.dispose();
});

test("missing login on another provider stays quiet without retry timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const manager = new Manager(async () => { calls++; return { ok: false, unavailable: true, error: "login" }; });
  await manager.refresh(ctx("anthropic"));
  assert.equal(manager.state, "idle");
  t.mock.timers.tick(600_000);
  assert.equal(calls, 1);
  manager.dispose();
});

function runtime(cursorUsage, codexUsage = new CodexManager()) {
  return { cursorUsage, codexUsage, tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    context: { label: "0%", color: "#ffffff" } };
}

test("footer matches OpenAI percentage and reset countdown, clamps exhaustion, and fits narrow widths", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Number(payload.billingCycleEnd) - 5 * 24 * 60 * 60_000 });
  const cursor = new Manager();
  cursor.setReport(normalize(payload));
  const state = runtime(cursor);
  const line = stripAnsi(renderUsageLine(160, ctx(), {}, state));
  assert.match(line, /Cursor.*91% 5d/);
  assert.doesNotMatch(line, /OpenAI|left|resets/);
  for (const width of [0, 1, 10, 25, 60, 80]) {
    assert.ok(stripAnsi(renderUsageLine(width, ctx(), {}, state)).length <= width);
  }
  cursor.setReport(normalize({ planUsage: { totalPercentUsed: 150 } }));
  assert.match(stripAnsi(renderUsageLine(160, ctx(), {}, state)), /0%/);
  cursor.dispose();
  state.codexUsage.dispose();
});

test("Cursor countdown switches to hours, minutes, and now like OpenAI", (t) => {
  const now = 1_790_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const cursor = new Manager();
  const state = runtime(cursor);
  for (const [offset, label] of [[25 * 60 * 60_000, "2d"], [2 * 60 * 60_000, "2h"], [37 * 60_000, "37m"], [0, "now"]]) {
    cursor.setReport(normalize({ ...payload, billingCycleEnd: now + offset }));
    assert.ok(stripAnsi(renderUsageLine(160, ctx(), {}, state)).includes(`91% ${label}`));
  }
  cursor.dispose(); state.codexUsage.dispose();
});

test("both subscription chips render, active provider first, and errors mark cached Cursor data stale", async () => {
  const cursor = new Manager(async () => ({ ok: false, error: "offline" }));
  cursor.setReport(normalize(payload));
  const codex = new CodexManager();
  codex.setReport({ capturedAt: Date.now(), source: "pi-auth", snapshots: [{ limitId: "codex", limitName: "Codex",
    primary: { usedPercent: 12, windowMinutes: 300 }, secondary: { usedPercent: 22, windowMinutes: 10080 } }] });
  const state = runtime(cursor, codex);
  const cursorLine = stripAnsi(renderUsageLine(240, ctx(), {}, state));
  assert.ok(cursorLine.indexOf("Cursor") < cursorLine.indexOf("OpenAI"));
  const codexLine = stripAnsi(renderUsageLine(240, ctx("openai-codex"), {}, state));
  assert.ok(codexLine.indexOf("OpenAI") < codexLine.indexOf("Cursor"));
  await cursor.refresh(ctx(), true);
  assert.match(stripAnsi(renderUsageLine(240, ctx(), {}, state)), /Cursor.*stale/);
  cursor.dispose(); codex.dispose();
});

test("cursor-status supports cache, refresh, report-only, clear, and validation", async (t) => {
  const harness = createCommandHarness(t);
  let response = payload;
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(response));
  await harness.command("--refresh");
  assert.match(harness.notifications.at(-1).message, /91% left/);
  const report = harness.manager.getReport();
  assert.equal(harness.manager.state, "loaded");
  await harness.command("");
  assert.equal(fetch.mock.callCount(), 1);
  assert.match(harness.notifications.at(-1).message, /cached/);
  response = { ...payload, planUsage: { totalPercentUsed: 20 } };
  await harness.command("--refresh --no-statusline --timeout 2");
  assert.equal(fetch.mock.callCount(), 2);
  assert.match(harness.notifications.at(-1).message, /80% left/);
  assert.equal(harness.manager.getReport(), report);
  await harness.command("--clear-statusline");
  assert.equal(harness.manager.getReport(), undefined);
  await harness.command("--bogus");
  assert.match(harness.notifications.at(-1).message, /\/cursor-status/);
  harness.event("session_shutdown");
});

for (const invalidation of ["clear", "shutdown", "disable"]) {
  test(`pending cursor-status cannot repopulate the manager after ${invalidation}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_790_000_000_000 });
    const harness = createCommandHarness(t);
    const started = deferred(), response = deferred();
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      started.resolve();
      return response.promise; // Deliberately ignores abort to exercise generation guards.
    });
    const pending = harness.command("--refresh");
    await started.promise;
    if (invalidation === "clear") await harness.command("--clear-statusline");
    else if (invalidation === "shutdown") harness.event("session_shutdown");
    else {
      await harness.toggle("off");
      await harness.toggle("on"); // A re-enable must not make the old command valid again.
      // Cancel the new background request started by enabling.
      harness.manager.clear();
    }
    response.resolve(Response.json(payload));
    await pending;
    assert.equal(harness.manager.getReport(), undefined);
    assert.equal(harness.manager.state, "idle");
    const calls = fetch.mock.callCount();
    t.mock.timers.tick(600_000);
    await Promise.resolve();
    assert.equal(fetch.mock.callCount(), calls);
    assert.ok(!harness.notifications.some((n) => n.message.includes("Cursor Subscription Usage")));
  });
}

for (const overlap of ["command-command", "background-command", "command-background"]) {
  test(`${overlap} requests completed in reverse order retain only the latest report`, async (t) => {
    const harness = createCommandHarness(t);
    const firstStarted = deferred(), secondStarted = deferred();
    const first = deferred(), second = deferred();
    const signals = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      signals.push(options.signal);
      const index = signals.length;
      (index === 1 ? firstStarted : secondStarted).resolve();
      return (index === 1 ? first : second).promise;
    });
    const p1 = overlap === "background-command"
      ? harness.manager.refresh(harness.context, true) : harness.command("--refresh");
    await firstStarted.promise;
    const p2 = overlap === "command-background"
      ? harness.manager.refresh(harness.context, true) : harness.command("--refresh");
    await secondStarted.promise;
    second.resolve(Response.json({ ...payload, planUsage: { totalPercentUsed: 20 } }));
    await p2;
    first.resolve(Response.json(payload));
    await p1;
    assert.equal(harness.manager.getReport().totalPercentUsed, 20);
    assert.equal(signals[0].aborted, true);
    assert.ok(!harness.notifications.some((n) => n.message.includes("91% left")));
  });
}

test("failed explicit refresh marks a retained report stale and identifies subsequent cached output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_790_000_000_000 });
  const harness = createCommandHarness(t);
  harness.manager.setReport(normalize(payload));
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("error", { status: 500 }));
  await harness.command("--refresh");
  assert.equal(harness.manager.state, "error");
  assert.equal(harness.manager.isCacheFresh(), false);
  assert.match(stripAnsi(renderUsageLine(160, harness.context, {}, runtime(harness.manager))), /stale/);
  await harness.command("");
  assert.equal(fetch.mock.callCount(), 1);
  assert.match(harness.notifications.at(-1).message, /cached.*stale/);
  assert.match(harness.notifications.at(-1).message, /91% left/);
  t.mock.timers.tick(59_999);
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.timers.tick(1);
  // Join the scheduled retry, not a third request.
  await harness.manager.refresh(harness.context);
  assert.equal(fetch.mock.callCount(), 2);
});

for (const retained of [false, true]) {
  test(`non-forced event refreshes honor backoff ${retained ? "with" : "without"} retained data`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_790_000_000_000 });
    let calls = 0;
    const manager = new Manager(async () => { calls++; return { ok: false, error: "offline" }; });
    t.after(() => manager.dispose());
    if (retained) {
      manager.setReport(normalize(payload));
      t.mock.timers.tick(300_000);
    }
    await manager.refresh(ctx());
    for (let i = 0; i < 5; i++) await manager.refresh(ctx());
    assert.equal(calls, 1);
    t.mock.timers.tick(59_999);
    await manager.refresh(ctx());
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await manager.refresh(ctx());
    assert.equal(calls, 2);
    // The explicit bypass is still allowed during the second retry interval.
    await manager.refresh(ctx(), true);
    assert.equal(calls, 3);
    manager.clear();
    await manager.refresh(ctx());
    assert.equal(calls, 4);
  });
}

test("report-only refresh failures and overlapping queries leave footer state untouched", async (t) => {
  const harness = createCommandHarness(t);
  harness.manager.setReport(normalize(payload));
  const cached = harness.manager.getReport();
  const started = deferred(), response = deferred();
  let calls = 0, backgroundSignal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (++calls === 1) return new Response("error", { status: 500 });
    if (calls === 2) {
      backgroundSignal = options.signal;
      started.resolve();
      return response.promise;
    }
    return Response.json({ ...payload, planUsage: { totalPercentUsed: 20 } });
  });
  await harness.command("--refresh --no-statusline");
  assert.match(harness.notifications.at(-1).message, /HTTP 500/);
  assert.equal(harness.manager.state, "loaded");
  assert.equal(harness.manager.isCacheFresh(), true);
  assert.equal(harness.manager.getReport(), cached);
  const pending = harness.manager.refresh(harness.context, true);
  await started.promise;
  await harness.command("--refresh --no-statusline");
  assert.equal(backgroundSignal.aborted, false);
  assert.equal(harness.manager.getReport(), cached);
  assert.match(harness.notifications.at(-1).message, /80% left/);
  response.resolve(Response.json(payload));
  await pending;
  assert.equal(harness.manager.getReport().totalPercentUsed, 9.032);
});

test("model selection and session-tree events cannot bypass the retry deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_790_000_000_000 });
  const harness = createCommandHarness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("error", { status: 500 }));
  await harness.manager.refresh(harness.context);
  for (let i = 0; i < 3; i++) {
    harness.event("model_select", { model: harness.context.model });
    harness.event("session_tree");
    await harness.manager.refresh(harness.context);
  }
  assert.equal(fetch.mock.callCount(), 1);
  await harness.command("");
  assert.match(harness.notifications.at(-1).message, /HTTP 500/);
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.timers.tick(60_000);
  await harness.manager.refresh(harness.context);
  assert.equal(fetch.mock.callCount(), 2);
});

test("managed command timeout is respected and a disposed manager cannot restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_790_000_000_000 });
  const harness = createCommandHarness(t);
  const started = deferred();
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });
  const pending = harness.command("--refresh --timeout 2");
  await started.promise;
  t.mock.timers.tick(1999);
  assert.equal(harness.manager.state, "loading");
  t.mock.timers.tick(1);
  await pending;
  assert.match(harness.notifications.at(-1).message, /timed out/);
  harness.event("session_shutdown");
  harness.manager.setReport(normalize(payload), harness.context);
  await harness.manager.refresh(harness.context, true);
  await harness.command("--refresh");
  t.mock.timers.tick(600_000);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(harness.manager.getReport(), undefined);
  assert.equal(harness.manager.state, "idle");
});

test("optional percentages and absent spend data remain unavailable; omitted scalar spend means zero", () => {
  const omitted = normalize({ planUsage: {}, spendLimitUsage: {} });
  assert.equal(omitted.autoPercentUsed, undefined);
  assert.equal(omitted.apiPercentUsed, undefined);
  assert.equal(omitted.onDemandDollars, 0);
  const missing = normalize({ billingCycleEnd: payload.billingCycleEnd });
  assert.equal(missing.onDemandDollars, undefined);
  assert.match(formatReport(missing), /On-Demand: unavailable/);
  const zero = normalize({ planUsage: { autoPercentUsed: 0, apiPercentUsed: 0 }, spendLimitUsage: { individualUsed: 0 } });
  assert.equal(zero.autoPercentUsed, 0);
  assert.equal(zero.apiPercentUsed, 0);
  assert.equal(zero.onDemandDollars, 0);
  for (const value of ["bad", -1, NaN, Infinity, null, false]) {
    const invalid = normalize({ planUsage: { autoPercentUsed: value, apiPercentUsed: value }, spendLimitUsage: { individualUsed: value } });
    assert.equal(invalid.autoPercentUsed, undefined);
    assert.equal(invalid.apiPercentUsed, undefined);
    assert.equal(invalid.onDemandDollars, undefined);
    assert.match(formatReport(invalid), /Auto: unavailable/);
    assert.match(formatReport(invalid), /API: unavailable/);
    assert.match(formatReport(invalid), /On-Demand: unavailable/);
  }
});
