"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { QueryNotifications, configureNotifications } = require("../notifications.cjs");
const { prepareNotifications } = require("../scripts/prepare-notifications.cjs");

function fixture() {
  const shown = [], actions = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { shown.push(this); }
    close() { this.closed = true; }
  }
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => actions.push("restore"),
    show: () => actions.push("show"),
    focus: () => actions.push("focus"),
  };
  const notifications = new QueryNotifications({ Notification, getWindow: () => window });
  return { notifications, Notification, window, shown, actions };
}

test("each provider notifies once at completion, without query or workspace content", () => {
  const { notifications, shown } = fixture();
  for (const provider of ["claude", "codex"]) {
    const notify = notifications.forQuery(provider);
    notify({ type: "delta", text: "Synthetic patient response" });
    notify({ type: "status", text: "Private workspace path" });
    assert.equal(shown.length, provider === "claude" ? 0 : 1);
    notify({ type: "done", failed: false, cancelled: false, text: "Private content" });
    notify({ type: "done", failed: false, cancelled: false });
  }
  assert.deepEqual(shown.map(item => item.options), [
    { title: "ARMa", body: "Claude query complete. Your response is ready." },
    { title: "ARMa", body: "Codex query complete. Your response is ready." },
  ]);
  assert.equal(shown[0].closed, true);
});

test("cancelled queries stay silent; failures have a generic distinct notification", () => {
  const { notifications, shown } = fixture();
  for (const provider of ["claude", "codex"]) {
    notifications.forQuery(provider)({ type: "done", cancelled: true, failed: true });
    const notify = notifications.forQuery(provider);
    notify({ type: "error", text: "Sensitive provider error" });
    notify({ type: "done", failed: true, cancelled: false });
  }
  assert.deepEqual(shown.map(item => item.options.body), [
    "Claude query failed. Open ARMa for details.",
    "Codex query failed. Open ARMa for details.",
  ]);
});

test("notification clicks restore and focus ARMa, including after a banner times out", () => {
  const { notifications, shown, actions } = fixture();
  notifications.forQuery("codex")({ type: "done" });
  shown[0].emit("close", { reason: "timedOut" });
  assert.equal(notifications.latest, shown[0]);
  shown[0].emit("click");
  assert.deepEqual(actions, ["restore", "show", "focus"]);
  notifications.clear();
  assert.equal(shown[0].closed, true);
  assert.equal(notifications.latest, null);
});

test("OS rejection, unsupported systems, and closed windows do not interrupt a query", () => {
  const { notifications, Notification, window, shown, actions } = fixture();
  Notification.isSupported = () => false;
  notifications.forQuery("claude")({ type: "done" });
  assert.equal(shown.length, 0);
  Notification.isSupported = () => true;
  notifications.forQuery("claude")({ type: "done" });
  shown[0].emit("failed", {}, "Permission denied");
  assert.equal(notifications.latest, null);
  window.isDestroyed = () => true;
  shown[0].emit("click");
  notifications.forQuery("codex")({ type: "done" });
  assert.equal(shown.length, 1);
  assert.deepEqual(actions, []);
  window.isDestroyed = () => false;
  Notification.prototype.show = () => { throw new Error("Native failure"); };
  assert.doesNotThrow(() => notifications.forQuery("codex")({ type: "done" }));
  assert.equal(notifications.latest, null);
});

test("Windows notifications have a stable application and activator identity", () => {
  const identities = [], activators = [];
  const app = {
    setAppUserModelId: id => identities.push(id),
    setToastActivatorCLSID: id => activators.push(id),
  };
  configureNotifications(app, "darwin");
  assert.deepEqual(identities, []);
  configureNotifications(app, "win32");
  configureNotifications(app, "win32");
  assert.deepEqual(identities, ["com.arma.workspace", "com.arma.workspace"]);
  assert.equal(activators[0], activators[1]);
  assert.match(activators[0], /^\{[A-F\d-]{36}\}$/);
});

test("local Mac launches sign only an unverified development bundle, without a certificate", () => {
  const calls = [];
  const binary = "/tmp/ARMa test/Electron.app/Contents/MacOS/Electron";
  const run = (file, args) => {
    calls.push({ file, args });
    if (args.includes("--verify")) throw new Error("Incomplete linker signature");
  };
  prepareNotifications(binary, { platform: "win32", run });
  assert.equal(calls.length, 0);
  prepareNotifications(binary, { platform: "darwin", run });
  assert.deepEqual(calls[1], {
    file: "/usr/bin/codesign",
    args: ["--force", "--deep", "--sign", "-", "/tmp/ARMa test/Electron.app"],
  });
  const verified = [];
  prepareNotifications(binary, { platform: "darwin", run: (...args) => verified.push(args) });
  assert.equal(verified.length, 1);
});
