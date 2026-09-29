"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify, stripVTControlCharacters } = require("node:util");
const { providerEnvironment } = require("./agents.cjs");

const execFileAsync = promisify(execFile);
const BASE_ARGS = ["--setting-sources", "", "--settings", '{"disableAllHooks":true}', "auth"];
const MAX_OUTPUT = 64 * 1024;

function authorizationURL(text) {
  for (const candidate of stripVTControlCharacters(text).match(/https:\/\/[^\s<>"']+/g) || []) {
    try {
      const url = new URL(candidate);
      const endpoint = `${url.origin}${url.pathname}`;
      if (["https://claude.com/cai/oauth/authorize", "https://claude.ai/oauth/authorize"].includes(endpoint) &&
          !url.username && !url.password && url.searchParams.get("state") &&
          url.searchParams.get("code_challenge")) return url.href;
    } catch {}
  }
  return null;
}

// Claude owns OAuth, its loopback callback and credential storage. ARMa only
// supervises the pinned CLI. Never forward raw output, URLs or credentials to
// logs, conversations, application data or model tools.
class ClaudeAuth {
  constructor({ resolveBinary, emit = () => {}, openExternal, spawnProcess = spawn,
    exec = execFileAsync, env = process.env, runtimeParent = os.tmpdir(),
    timeout = 10 * 60 * 1000 } = {}) {
    Object.assign(this, { resolveBinary, emit, openExternal, spawnProcess, exec, env, runtimeParent, timeout });
    this.state = { phase: "unknown", canOpenBrowser: false };
    this.run = null;
    this.revision = 0;
    this.disposed = false;
    this.checking = null;
  }
  get pending() { return !!this.run; }
  snapshot() { return { ...this.state }; }
  update(phase, extra = {}) {
    this.state = { phase, canOpenBrowser: !!this.run?.url, ...extra };
    if (!this.disposed) this.emit(this.snapshot());
    return this.snapshot();
  }
  environment(binary) {
    const env = providerEnvironment("claude", this.env);
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.DISABLE_AUTOUPDATER = "1";
    if (binary.node) env.ELECTRON_RUN_AS_NODE = "1";
    return env;
  }
  async readStatus(binary) {
    const cwd = await fs.mkdtemp(path.join(this.runtimeParent, "arma-auth-check-"));
    try {
      let result;
      try {
        result = await this.exec(binary.command, [...binary.args, ...BASE_ARGS, "status", "--json"],
          { cwd, env: this.environment(binary), windowsHide: true, timeout: 10000, maxBuffer: MAX_OUTPUT });
      } catch (error) {
        if (error.code !== 1) throw new Error("Could not check Claude sign-in. Try refreshing Connections.");
        result = { stdout: error.stdout };
      }
      const parsed = JSON.parse(result.stdout);
      if (typeof parsed.loggedIn !== "boolean") throw new Error("Invalid status.");
      return parsed.loggedIn;
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }
  async refresh() {
    if (this.disposed || this.run) return this.snapshot();
    if (this.checking) return this.checking;
    const revision = this.revision;
    this.checking = (async () => {
      try {
        const binary = await this.resolveBinary();
        const loggedIn = binary ? await this.readStatus(binary) : false;
        if (revision === this.revision && !this.disposed)
          this.update(binary ? (loggedIn ? "signed-in" : "signed-out") : "unavailable");
      } catch {
        if (revision === this.revision && !this.disposed)
          this.update("error", { message: "Could not check Claude sign-in. Try refreshing Connections." });
      }
      return this.snapshot();
    })();
    try { return await this.checking; } finally { this.checking = null; }
  }
  async start() {
    if (this.disposed) throw new Error("The sign-in connection is closed.");
    if (this.run) return this.snapshot();
    const run = { child: null, cwd: null, url: null, output: "", bytes: 0, closed: false };
    this.run = run;
    this.revision++;
    this.update("starting");
    try {
      const binary = await this.resolveBinary();
      if (this.run !== run) return this.snapshot();
      if (!binary) throw new Error("Claude unavailable.");
      run.cwd = await fs.mkdtemp(path.join(this.runtimeParent, "arma-auth-login-"));
      if (this.run !== run) {
        await fs.rm(run.cwd, { recursive: true, force: true });
        return this.snapshot();
      }
      run.binary = binary;
      const child = this.spawnProcess(binary.command, [...binary.args, ...BASE_ARGS, "login", "--claudeai"], {
        cwd: run.cwd, env: this.environment(binary), shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
      run.child = child;
      const output = (chunk) => {
        if (this.run !== run) return;
        run.bytes += chunk.length;
        if (run.bytes > MAX_OUTPUT) { this.stop("error", "Claude sign-in could not continue. Try again."); return; }
        run.output += chunk.toString("utf8");
        // Read only complete lines: a URL may be split across stdout chunks.
        const end = run.output.lastIndexOf("\n");
        if (end < 0) return;
        const lines = run.output.slice(0, end + 1);
        run.output = run.output.slice(end + 1);
        const url = authorizationURL(lines);
        if (url) { run.url = url; this.update("waiting"); }
        if (lines.includes("Invalid code."))
          this.update("waiting", { message: "Copy the full sign-in code from your browser and try again." });
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.stdin.on("error", () => { if (this.run === run) this.stop("error", "Claude sign-in closed. Try again."); });
      child.once("error", () => { if (this.run === run) this.stop("error", "Could not start Claude sign-in. Restart ARMa and try again."); });
      child.once("close", async (code) => {
        run.closed = true;
        clearTimeout(run.killTimer);
        clearTimeout(run.timer);
        run.output = "";
        run.url = null;
        if (this.run === run) {
          this.update("checking");
          let signedIn = false;
          try { if (code === 0) signedIn = await this.readStatus(binary); } catch {}
          if (this.run === run) {
            this.run = null;
            this.revision++;
            this.update(signedIn ? "signed-in" : "error", signedIn ? {} : {
              message: "Claude sign-in did not finish. Check your internet connection and try again.",
            });
          }
        }
        await fs.rm(run.cwd, { recursive: true, force: true }).catch(() => {});
      });
      run.timer = setTimeout(() => {
        if (this.run === run) this.stop("error", "Sign-in timed out. Try again.");
      }, this.timeout);
      run.timer.unref?.();
      this.update("waiting");
    } catch {
      if (this.run === run) this.stop("error", "Could not start Claude sign-in. Restart ARMa and try again.");
    }
    return this.snapshot();
  }
  async reopenBrowser() {
    const url = this.run?.url;
    if (!url) throw new Error("The sign-in page is not ready yet.");
    try { await this.openExternal(url); }
    catch { throw new Error("Could not open your default browser. Check Windows default apps and try again."); }
  }
  submitCode(value) {
    const run = this.run;
    if (!run?.child || !run.url || this.state.phase !== "waiting") throw new Error("Start sign-in first.");
    if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9._~-]+#[A-Za-z0-9._~-]+$/.test(value.trim()))
      throw new Error("Copy the full sign-in code from your browser, including the # separator.");
    run.child.stdin.write(value.trim() + "\n");
    return this.update("waiting");
  }
  stop(phase = "signed-out", message) {
    const run = this.run;
    this.run = null;
    this.revision++;
    if (run) {
      clearTimeout(run.timer);
      run.url = null;
      run.output = "";
      const kill = signal => {
        try {
          if (process.platform !== "win32" && run.child.pid) process.kill(-run.child.pid, signal);
          else run.child.kill(signal);
        } catch { try { run.child?.kill(signal); } catch {} }
      };
      if (run.child && !run.closed) {
        kill("SIGTERM");
        run.killTimer = setTimeout(() => { if (!run.closed) kill("SIGKILL"); }, 1500);
        run.killTimer.unref?.();
      } else if (run.cwd) fs.rm(run.cwd, { recursive: true, force: true }).catch(() => {});
    }
    return this.update(phase, message ? { message } : {});
  }
  cancel() { this.stop(); return this.refresh(); }
  dispose() { this.disposed = true; this.stop(); }
}

module.exports = { ClaudeAuth, authorizationURL };
