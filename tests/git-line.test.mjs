import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = fileURLToPath(new URL("../", import.meta.url));
let buildDir, renderPrimaryLine, renderGitLine, PullRequestCache, stripAnsi;
const oldPath = process.env.PATH;

before(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "pi-infobar-git-test-"));
  const compiled = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
    "--project", join(root, "tsconfig.json"), "--outDir", buildDir, "--noEmit", "false"], { cwd: root, encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  writeFileSync(join(buildDir, "package.json"), '{"type":"module"}');
  mkdirSync(join(buildDir, "node_modules/@earendil-works"), { recursive: true });
  for (const pkg of ["pi-tui", "pi-coding-agent"]) {
    symlinkSync(join(root, "node_modules/@earendil-works", pkg), join(buildDir, "node_modules/@earendil-works", pkg), "dir");
  }
  // A fake `gh` that prints $FAKE_GH_OUTPUT, or fails like "no pull requests found" when unset.
  const bin = join(buildDir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\n[ -n "$FAKE_GH_OUTPUT" ] || exit 1\necho "$FAKE_GH_OUTPUT"\n');
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}${delimiter}${oldPath}`;

  const load = (file) => import(pathToFileURL(join(buildDir, file)).href);
  ({ renderPrimaryLine, renderGitLine } = await load("src/renderers.js"));
  ({ PullRequestCache } = await load("src/pull-request.js"));
  ({ stripAnsi } = await load("src/ansi.js"));
});

after(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_GH_OUTPUT;
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

function createRepo(branch) {
  const cwd = mkdtempSync(join(buildDir, "repo-"));
  git(cwd, "init", "-q", "-b", branch);
  // A global commit.gpgsign=true must not fail the fixture commit.
  git(cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
    "commit", "-q", "--allow-empty", "-m", "init");
  return cwd;
}

function createFooter(cwd, ghOutput) {
  if (ghOutput === undefined) delete process.env.FAKE_GH_OUTPUT;
  else process.env.FAKE_GH_OUTPUT = ghOutput;
  let resolveUpdate;
  const runtime = { thinkingLevel: "off", pullRequests: new PullRequestCache(() => resolveUpdate?.()) };
  const ctx = { cwd, model: { id: "test-model", provider: "test" } };
  const footerData = { getGitBranch: () => null };
  return {
    // Call right after the render that starts a lookup: lookups settle on a later tick.
    nextUpdate: () => new Promise((resolve) => (resolveUpdate = resolve)),
    primaryLine: (width = 160) => stripAnsi(renderPrimaryLine(width, ctx, runtime)),
    gitLine: (width = 160) => stripAnsi(renderGitLine(width, ctx, footerData, runtime)),
  };
}

test("the git line shows the branch and the pull request number after the lookup settles", async () => {
  const cwd = createRepo("feat/pr-chip");
  const footer = createFooter(cwd, '{"isDraft":false,"number":42,"state":"OPEN"}');

  assert.match(footer.gitLine(), /feat\/pr-chip/);
  assert.doesNotMatch(footer.gitLine(), /#42/, "The first render must not wait for gh");
  await footer.nextUpdate();
  assert.match(footer.gitLine(), /feat\/pr-chip.*#42/);
  assert.doesNotMatch(footer.primaryLine(), /feat\/pr-chip/, "The branch must leave the primary line");
});

test("a failed gh lookup shows the branch without a pull request chip", async () => {
  const cwd = createRepo("feat/no-pr");
  const footer = createFooter(cwd, undefined);

  footer.gitLine();
  await footer.nextUpdate();
  const line = footer.gitLine();
  assert.match(line, /feat\/no-pr/);
  assert.doesNotMatch(line, /#/);
});

test("a failed refresh keeps the known pull request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const cwd = createRepo("feat/keep-pr");
  const footer = createFooter(cwd, '{"isDraft":false,"number":7,"state":"OPEN"}');

  footer.gitLine();
  await footer.nextUpdate();
  assert.match(footer.gitLine(), /#7/);

  delete process.env.FAKE_GH_OUTPUT;
  t.mock.timers.tick(61_000);
  footer.gitLine();
  await footer.nextUpdate();
  assert.match(footer.gitLine(), /#7/, "A network error or timeout must not hide a known pull request");
});

test("a detached HEAD skips the pull request lookup", (t) => {
  const cwd = createRepo("feat/detached");
  git(cwd, "checkout", "-q", "--detach");
  const pullRequests = { get: t.mock.fn() };
  // Pi reports a detached HEAD as the branch "detached".
  const footerData = { getGitBranch: () => "detached" };

  const line = stripAnsi(renderGitLine(160, { cwd }, footerData, { pullRequests }));
  assert.match(line, /detached/);
  assert.equal(pullRequests.get.mock.callCount(), 0);
});

test("a missing gh is looked for again after ten minutes, not every minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const testPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(buildDir, "empty-bin-"));
  t.after(() => (process.env.PATH = testPath));

  let lookups = 0;
  const cache = new PullRequestCache(() => (lookups += 1));
  // A missing binary fails on the next tick, so one setImmediate observes the settled lookup.
  const render = async () => {
    cache.get(buildDir, "feat/no-gh");
    await new Promise(setImmediate);
  };

  await render();
  assert.equal(lookups, 1);
  t.mock.timers.tick(2 * 60_000);
  await render();
  assert.equal(lookups, 1, "A missing gh must not be looked for every minute");
  t.mock.timers.tick(9 * 60_000);
  await render();
  assert.equal(lookups, 2);
});

test("narrow terminals drop the pull request chip before the branch name", async () => {
  const cwd = createRepo("feat/a-fairly-long-branch-name");
  const footer = createFooter(cwd, '{"isDraft":false,"number":4242,"state":"MERGED"}');

  footer.gitLine();
  await footer.nextUpdate();
  assert.match(footer.gitLine(), /feat\/a-fairly-long-branch-name.*#4242/);
  const narrow = footer.gitLine(30);
  assert.doesNotMatch(narrow, /#4242/);
  assert.match(narrow, /feat\/a-fairly/);
  assert.ok(visibleWidth(narrow) <= 30, `Line must fit 30 columns: ${JSON.stringify(narrow)}`);
});

test("very narrow terminals shorten the branch name instead of cutting the chip", async () => {
  const cwd = createRepo("feat/a-fairly-long-branch-name");
  const footer = createFooter(cwd, undefined);
  const closingArrow = footer.gitLine().at(-1);
  await footer.nextUpdate();

  for (const width of [20, 19, 12]) {
    const line = footer.gitLine(width);
    const shown = JSON.stringify(line);
    assert.ok(visibleWidth(line) <= width, `Line must fit ${width} columns: ${shown}`);
    assert.match(line, /…/, `The branch name must keep its ellipsis at ${width} columns: ${shown}`);
    assert.ok(line.endsWith(closingArrow), `The chip must keep its closing arrow at ${width} columns: ${shown}`);
  }
});

test("the git line is blank outside a git repository", () => {
  const footer = createFooter(mkdtempSync(join(buildDir, "plain-")), undefined);
  assert.equal(footer.gitLine(), "");
});
