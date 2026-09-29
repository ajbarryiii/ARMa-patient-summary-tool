"use strict";

// Opt-in native delivery check. Sends synthetic completion notifications without
// model inference. Use --click to also test a real Notification Center click.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");
const { prepareNotifications } = require("../scripts/prepare-notifications.cjs");

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "arma-native-notifications-"));
  const project = path.resolve(__dirname, "..");
  const executablePath = process.env.ARM_NOTIFICATION_TEST_BINARY || require("electron");
  prepareNotifications(executablePath);
  const env = { ...process.env, ARM_USER_DATA: path.join(temporary, "app-data") };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ executablePath, args: [project], env });
  try {
    const page = await application.firstWindow();
    await expect(page.locator("#welcome")).toBeVisible();
    await application.evaluate(({ app, Notification, dialog }, workspace) => {
      const requireApp = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
      const { AgentBridge } = requireApp("./agents.cjs");
      global.__nativeNotifications = [];
      const show = Notification.prototype.show;
      Notification.prototype.show = function () {
        const result = { body: this.body, status: "pending" };
        global.__nativeNotifications.push(result);
        this.once("show", () => { result.status = "show"; });
        this.once("failed", () => { result.status = "failed"; });
        this.once("click", () => { result.clicked = true; });
        return show.call(this);
      };
      AgentBridge.prototype.start = async function (_args, emit) {
        global.__finishNotificationQuery = () => emit({ runId: "native-test", type: "done", cancelled: false, failed: false });
        return { runId: "native-test" };
      };
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: workspace });
    }, path.join(temporary, "Synthetic workspace"));
    await page.locator("#welcome-create").click();
    await expect(page.locator("#workspace-name")).toHaveText("Synthetic workspace");

    for (const provider of ["claude", "codex"]) {
      await page.evaluate(provider => window.arma.start({
        provider, prompt: "Synthetic notification check", conversationId: "native-notifications",
      }), provider);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
      await application.evaluate(() => global.__finishNotificationQuery());
      await expect.poll(() => application.evaluate(() => global.__nativeNotifications.at(-1)?.status), { timeout: 30000 }).toBe("show");
      const name = provider === "claude" ? "Claude" : "Codex";
      if (process.platform === "darwin") {
        await expect.poll(() => application.evaluate(async ({ Notification }) =>
          (await Notification.getHistory()).map(item => item.body)), { timeout: 10000 })
          .toContain(`${name} query complete. Your response is ready.`);
      }
      console.log(`${name} native notification delivered while ARMa was minimized.`);
      if (provider === "codex" && process.argv.includes("--click")) {
        console.log("Click the ARMa notification in Notification Center to finish the check.");
        await expect.poll(() => application.evaluate(() => global.__nativeNotifications.at(-1)?.clicked), { timeout: 60000 }).toBe(true);
        await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return !window.isMinimized() && window.isVisible() && window.isFocused();
        }), { timeout: 60000 }).toBe(true);
        console.log("Native click restored and focused ARMa.");
      } else {
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
      }
    }
    assert.equal(await application.evaluate(() => global.__nativeNotifications.length), 2);
    console.log("Native notification smoke passed; no live provider inference was used.");
  } finally {
    await application.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
