"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");
const project = path.resolve(__dirname, "..");
let app;
const errors = [];

async function launch(userData) {
  const env = { ...process.env, ARM_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(project, "main.cjs")], cwd: project, env });
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  await expect(page.locator("#model")).toBeEnabled({ timeout: 30000 });
  await app.evaluate(({ app, Notification }) => {
    const requireApp = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
    const { AgentBridge } = requireApp("./agents.cjs");
    Notification.isSupported = () => false;
    global.sessionCalls = [];
    AgentBridge.prototype.status = async () => [
      { id: "claude", name: "Claude Code", available: true, models: [{ id: "sonnet", name: "Claude Sonnet", efforts: ["high"], defaultEffort: "" }] },
      { id: "codex", name: "Codex", available: true, models: [{ id: "test-codex", name: "Codex fixture", efforts: ["medium", "high"], defaultEffort: "medium" }] },
    ];
    AgentBridge.prototype.start = async function (args, emit) {
      const key = JSON.stringify([args.provider, args.workspace, args.conversationId, args.redaction ? "redaction" : "workspace"]);
      const previous = this.history.get(key) || [];
      global.sessionCalls.push({ provider: args.provider, prompt: args.prompt, conversationId: args.conversationId, previous });
      const runId = `session-run-${global.sessionCalls.length}`;
      this.runs.set(runId, { emit });
      emit({ runId, type: "delta", text: `${args.provider}: ${args.prompt}` });
      if (args.prompt !== "Hold this turn") setTimeout(() => {
        this.remember(key, previous, args.prompt, `${args.provider}: ${args.prompt}`);
        this.runs.delete(runId);
        emit({ runId, type: "done" });
      }, 40);
      return { runId };
    };
    AgentBridge.prototype.cancel = function (runId) {
      const run = this.runs.get(runId);
      if (!run) return false;
      this.runs.delete(runId);
      // A shutdown can interrupt the stream before the renderer receives done.
      if (!this.disposed) run.emit({ runId, type: "done", cancelled: true });
      return true;
    };
  });
  await page.evaluate(() => loadProviders());
  return page;
}
async function open(page, root) {
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, root);
  if (await page.locator("#sidebar").isHidden()) await page.locator("#expand-sidebar").click();
  await page.locator("#open-workspace").click();
  await expect(page.locator("#workspace-name")).toHaveText(path.basename(root));
  await expect(page.locator("#prompt")).toBeEnabled();
}
async function send(page, prompt, hold = false) {
  await page.locator("#prompt").fill(prompt);
  await page.locator("#send").click();
  if (hold) await expect(page.locator("#stop")).toBeEnabled();
  else {
    await expect(page.locator(".message.assistant .message-body").last()).toContainText(prompt);
    await expect(page.locator("#stop")).toBeHidden();
  }
}
const session = (page, title) => page.locator(".session-row").filter({ hasText: title });

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "arma-session-smoke-"));
  const root = path.join(temporary, "Alpha workspace"), other = path.join(temporary, "Beta workspace"), data = path.join(temporary, "app-data");
  await fs.mkdir(root);
  await fs.mkdir(other);
  try {
    let page = await launch(data);
    await open(page, root);
    await expect(page.locator("#files-panel")).toBeVisible();
    await expect(page.locator(".session-row")).toHaveCount(1);
    const before = await page.locator(".main").boundingBox();
    await page.locator("#collapse-sidebar").click();
    await expect(page.locator("#sidebar")).toBeHidden();
    const after = await page.locator(".main").boundingBox();
    assert(after.width > before.width + 200);
    if (process.platform === "darwin") assert((await page.locator("#expand-sidebar").boundingBox()).x >= 90);
    await page.locator("#expand-sidebar").click();
    await expect(page.locator("#files-panel")).toBeVisible();
    await send(page, "Alpha review");
    await page.locator("#prompt").fill("Alpha unfinished draft");
    await page.locator("#new-conversation").click();
    await expect(page.locator("#messages .message")).toHaveCount(0);
    await expect(page.locator("#prompt")).toHaveValue("");
    await send(page, "Beta review");
    await page.locator("#prompt").fill("Beta unfinished draft");
    await page.locator("#sidebar-view").click();
    await expect(page.locator("#sessions-panel")).toBeVisible();
    await expect(page.locator("#files-panel")).toBeHidden();
    await expect(page.locator(".session-row")).toHaveCount(2);
    await session(page, "Alpha review").click();
    await expect(page.locator(".message.user .message-body")).toHaveText("Alpha review");
    await expect(page.locator("#prompt")).toHaveValue("Alpha unfinished draft");
    await page.locator("#model").selectOption("codex:test-codex");
    await expect(page.locator("#messages .message")).toHaveCount(0);
    await send(page, "Alpha Codex review");
    await page.locator("#effort").selectOption("high");
    await page.locator("#prompt").fill("Codex unfinished draft");
    await session(page, "Beta review").click();
    await expect(page.locator("#model")).toHaveValue("claude:sonnet");
    await expect(page.locator("#prompt")).toHaveValue("Beta unfinished draft");
    await session(page, "Alpha review").click();
    await expect(page.locator("#model")).toHaveValue("codex:test-codex");
    await expect(page.locator("#effort")).toHaveValue("high");
    await expect(page.locator("#prompt")).toHaveValue("Codex unfinished draft");
    await page.locator("#model").selectOption("claude:sonnet");
    await expect(page.locator("#prompt")).toHaveValue("Alpha unfinished draft");
    await send(page, "Alpha follow-up");
    const calls = await app.evaluate(() => global.sessionCalls);
    assert.notEqual(calls[0].conversationId, calls[1].conversationId);
    assert.notEqual(calls[0].conversationId, calls[2].conversationId);
    assert.deepEqual(calls[3].previous.map(message => message.content), ["Alpha review", "claude: Alpha review"]);
    await page.locator("#prompt").fill("Draft survives reopening");
    await page.screenshot({ path: path.join(temporary, "sessions.png") });

    await open(page, other);
    await expect(page.locator(".session-row")).toHaveCount(1);
    await expect(page.locator("#messages .message")).toHaveCount(0);
    await send(page, "Other workspace review");
    await open(page, root);
    await expect(page.locator(".session-row")).toHaveCount(2);
    await expect(page.locator("#prompt")).toHaveValue("Draft survives reopening");

    await page.locator("#new-session").click();
    await send(page, "Hold this turn", true);
    await expect(page.locator("#new-session")).toBeDisabled();
    await expect(page.locator("#new-conversation")).toBeDisabled();
    await expect(session(page, "Alpha review")).toBeDisabled();
    await page.locator("#collapse-sidebar").click();
    await expect(page.locator("#stop")).toBeEnabled();
    await page.screenshot({ path: path.join(temporary, "collapsed.png") });
    // Wait for the interrupted marker to reach disk, then close only this test instance.
    await page.evaluate(() => saveSessions());
    await app.close();
    app = null;

    page = await launch(data);
    await expect(page.locator("#sidebar")).toBeHidden();
    await open(page, root);
    await expect(page.locator("#sessions-panel")).toBeVisible();
    await expect(page.locator(".session-row")).toHaveCount(3);
    await expect(page.locator(".message.stopped")).toContainText("Interrupted");
    await expect(page.locator("#stop")).toBeHidden();
    await expect(page.locator("#new-session")).toBeEnabled();
    await session(page, "Alpha review").click();
    await expect(page.locator("#prompt")).toHaveValue("Draft survives reopening");
    await send(page, "Continue after restart");
    const resumed = await app.evaluate(() => global.sessionCalls[0]);
    assert.equal(resumed.conversationId, calls[0].conversationId);
    assert.deepEqual(resumed.previous.map(message => message.content), ["Alpha review", "claude: Alpha review", "Alpha follow-up", "claude: Alpha follow-up"]);
    await page.locator("#model").selectOption("codex:test-codex");
    await expect(page.locator("#prompt")).toHaveValue("Codex unfinished draft");
    await send(page, "Codex after restart");
    const codexResumed = await app.evaluate(() => global.sessionCalls[1]);
    assert.deepEqual(codexResumed.previous.map(message => message.content), ["Alpha Codex review", "codex: Alpha Codex review"]);
    await session(page, "Beta review").click();
    await expect(page.locator("#prompt")).toHaveValue("Beta unfinished draft");
    await expect(page.locator(".message.user .message-body")).toHaveText("Beta review");
    await page.locator("#sidebar-view").click();
    await expect(page.locator('.tree-row[data-path="unredacted"]')).toBeVisible();
    await expect(page.locator("#toast.error")).toBeHidden();
    assert.deepEqual(errors, []);
    console.log(`Session smoke passed. Synthetic screenshots: ${temporary}`);
  } catch (error) {
    await app?.windows()[0]?.screenshot({ path: path.join(temporary, "failure.png") }).catch(() => {});
    console.error(`Session smoke artifacts: ${temporary}`);
    throw error;
  } finally {
    await app?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
