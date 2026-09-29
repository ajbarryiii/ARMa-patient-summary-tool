"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { ClaudeAuth, authorizationURL } = require("../claude-auth.cjs");
const url = "https://claude.com/cai/oauth/authorize?state=synthetic-state&code_challenge=synthetic-challenge";
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await tick(); }
  throw new Error("Timed out waiting for auth fixture.");
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arma-auth-test-"));
  const events = [], calls = [], opened = [], children = [];
  let loggedIn = false;
  const auth = new ClaudeAuth({
    runtimeParent: root,
    env: { HOME: os.homedir(), PATH: process.env.PATH, OPENAI_API_KEY: "other-provider-secret", NODE_OPTIONS: "untrusted", CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    resolveBinary: async () => ({ command: "/bundled/claude.exe", args: [] }),
    emit: value => events.push(value),
    openExternal: async value => opened.push(value),
    exec: async (command, args, config) => {
      calls.push({ command, args, config });
      const stdout = JSON.stringify({ loggedIn, email: "private@example.test", accessToken: "secret-fixture" });
      if (!loggedIn) throw Object.assign(new Error("not signed in"), { code: 1, stdout });
      return { stdout };
    },
    spawnProcess: (command, args, config) => {
      calls.push({ command, args, config });
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.killed = [];
      child.kill = signal => { child.killed.push(signal); setImmediate(() => child.emit("close", null)); };
      children.push(child);
      return child;
    }, ...options,
  });
  t.after(async () => { auth.dispose(); await tick(); await fs.rm(root, { recursive: true, force: true }); });
  return { auth, events, calls, opened, children, root, setLoggedIn: value => { loggedIn = value; } };
}

test("auth status filters account details and runs outside workspaces with hidden processes", async t => {
  const f = await fixture(t);
  assert.equal((await f.auth.refresh()).phase, "signed-out");
  f.setLoggedIn(true);
  assert.equal((await f.auth.refresh()).phase, "signed-in");
  assert(!JSON.stringify(f.events).includes("private@example"));
  assert(!JSON.stringify(f.events).includes("secret-fixture"));
  for (const call of f.calls) {
    assert(call.config.cwd.startsWith(f.root));
    assert.equal(call.config.windowsHide, true);
    assert.equal(call.config.env.OPENAI_API_KEY, undefined);
    assert.equal(call.config.env.NODE_OPTIONS, undefined);
    assert(call.args.includes("--json"));
    assert(call.args.includes('{"disableAllHooks":true}'));
  }
});

test("only the expected HTTPS authorization endpoint can be reopened", () => {
  assert.equal(authorizationURL(`Visit: ${url}\n`), url);
  assert.equal(authorizationURL(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`), url);
  for (const bad of [url.replace("claude.com", "claude.com.evil.test"), url.replace("https:", "http:"),
    url.replace("claude.com", "someone@claude.com"), url.replace("/oauth/authorize", "/other"), "file:///tmp/secret", "https://claude.ai/oauth/authorize"])
    assert.equal(authorizationURL(bad), null);
});

test("login handles split output, code fallback and automatic verified completion without leaking output", async t => {
  const f = await fixture(t);
  await f.auth.start(); await f.auth.start();
  assert.equal(f.children.length, 1);
  const child = f.children[0], call = f.calls[0];
  assert.equal(call.config.windowsHide, true);
  assert.equal(call.config.shell, false);
  assert.deepEqual(call.config.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(call.args.slice(-2), ["login", "--claudeai"]);
  const line = `If the browser didn't open, visit: ${url}\n`;
  child.stdout.write(line.slice(0, -15));
  assert.equal(f.auth.snapshot().canOpenBrowser, false);
  child.stdout.write(line.slice(-15));
  assert.equal(f.auth.snapshot().canOpenBrowser, true);
  await f.auth.reopenBrowser(); assert.deepEqual(f.opened, [url]);
  assert.throws(() => f.auth.submitCode("not-a-complete-code"), /full sign-in code/);
  assert.throws(() => f.auth.submitCode("value#state\ninjected"), /full sign-in code/);
  let input = ""; child.stdin.on("data", data => { input += data; });
  f.auth.submitCode("synthetic-code#synthetic-state");
  assert.equal(input, "synthetic-code#synthetic-state\n");
  child.stderr.write("Invalid code. Please make sure the full code was copied.\n");
  assert.match(f.auth.snapshot().message, /full sign-in code/);
  f.setLoggedIn(true); child.emit("close", 0);
  await until(() => f.auth.snapshot().phase === "signed-in");
  assert.equal(f.auth.pending, false);
  await assert.rejects(f.auth.reopenBrowser(), /not ready/);
  const publicEvents = JSON.stringify(f.events);
  for (const privateValue of [url, "synthetic-code", "private@example", "secret-fixture"])
    assert(!publicEvents.includes(privateValue));
  await until(async () => (await fs.readdir(f.root)).length === 0);
});

test("successful process exit alone cannot claim a saved login", async t => {
  const f = await fixture(t);
  await f.auth.start(); f.children[0].emit("close", 0);
  await until(() => f.auth.snapshot().phase === "error");
  assert.match(f.auth.snapshot().message, /did not finish/);
});

test("cancelling terminates login, clears URLs and ignores late completion", async t => {
  const f = await fixture(t);
  await f.auth.start();
  const child = f.children[0];
  child.stdout.write(`${url}\n`);
  await f.auth.cancel();
  assert.deepEqual(child.killed, ["SIGTERM"]);
  f.setLoggedIn(true); child.emit("close", 0);
  assert.equal(f.auth.snapshot().phase, "signed-out");
  assert.equal(f.auth.snapshot().canOpenBrowser, false);
  await f.auth.start(); assert.equal(f.children.length, 2);
});

test("timeout and oversized output stop the login with safe retry messages", async t => {
  const f = await fixture(t, { timeout: 20 });
  await f.auth.start();
  await until(() => f.auth.snapshot().phase === "error");
  assert.match(f.auth.snapshot().message, /timed out/);
  await f.auth.start();
  f.children[1].stdout.write("x".repeat(65537));
  assert.equal(f.auth.snapshot().phase, "error");
  assert.equal(f.children[1].killed[0], "SIGTERM");
});

test("cancelling during binary lookup never launches a late sign-in process", async t => {
  let resolve;
  const f = await fixture(t, { resolveBinary: () => new Promise(done => { resolve = done; }) });
  const start = f.auth.start();
  f.auth.stop();
  resolve({ command: "/bundled/claude.exe", args: [] });
  await start;
  assert.equal(f.children.length, 0);
});

test("malformed status and process errors never expose raw credential-bearing output", async t => {
  const f = await fixture(t, { exec: async () => { throw new Error("raw-secret"); } });
  assert.equal((await f.auth.refresh()).phase, "error");
  await f.auth.start();
  f.children[0].emit("error", new Error("raw-secret"));
  assert.equal(f.auth.snapshot().phase, "error");
  assert(!JSON.stringify(f.events).includes("raw-secret"));
});
