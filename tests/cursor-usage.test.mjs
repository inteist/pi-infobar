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
