"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");

async function menuItems(app) {
  return app.evaluate(() => global.__fileMenu?.items.map(({ id, role, enabled }) => ({ id, role, enabled })));
}
async function selectMenu(app, id) {
  await app.evaluate(({ BrowserWindow }, id) => {
    const item = global.__fileMenu.items.find(item => item.id === id);
    if (!item?.enabled) throw new Error(`Missing or disabled menu action: ${id}`);
    const window = BrowserWindow.getAllWindows()[0];
    item.click({}, window, window.webContents);
    global.__fileMenuOptions.callback?.();
  }, id);
}
async function internalDrop(page, source, destination) {
  await page.evaluate(({ source, destination }) => {
    const rows = [...document.querySelectorAll(".tree-row")];
    const from = rows.find(row => row.dataset.path === source);
    const to = rows.find(row => row.dataset.path === destination);
    const dataTransfer = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
  }, { source, destination });
  await expect(page.locator("#add-files")).toBeEnabled();
}

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "arma-files-smoke-"));
  const workspace = path.join(temporary, "Workspace");
  await fs.mkdir(path.join(workspace, "redacted/Reports"), { recursive: true });
  await fs.mkdir(path.join(workspace, "unredacted/redaction-runs"), { recursive: true });
  await fs.writeFile(path.join(workspace, "redacted/notes.txt"), "Synthetic preview text");
  await fs.writeFile(path.join(workspace, "redacted/report.csv"), "id,amount\n0001,-1.20\n");
  await fs.writeFile(path.join(workspace, "unredacted/private.txt"), "Synthetic protected original");
  const env = { ...process.env, ARM_USER_DATA: path.join(temporary, "app-data"), ARM_ENABLE_CODEX: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve(__dirname, "../main.cjs")], env });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.locator("#welcome")).toBeVisible();
    await app.evaluate(({ dialog, Menu }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
      // Capture actual native Menu instances without commandeering the desktop
      // or the user's clipboard. Editing commands remain Electron-native roles.
      Menu.prototype.popup = function (options) {
        global.__fileMenu = this;
        global.__fileMenuOptions = options;
      };
    }, workspace);
    await page.locator("#welcome-open").click();
    await expect(page.locator("#workspace-name")).toHaveText("Workspace");

    const row = relative => page.locator(`.tree-row[data-path="${relative}"]`);
    await row("redacted/notes.txt").click();
    await expect(page.locator("#preview-content")).toHaveText("Synthetic preview text");
    await row("redacted/notes.txt").getByRole("button", { name: "Actions for notes.txt" }).click();
    await expect.poll(() => menuItems(app)).toContainEqual({ id: "rename", role: null, enabled: true });
    await selectMenu(app, "rename");
    await expect(page.locator("#file-dialog")).toBeVisible();
    await page.locator("#file-name-input").fill("renamed.txt");
    await page.locator("#file-name-submit").click();
    await expect(row("redacted/renamed.txt")).toBeVisible();
    await expect(page.locator("#preview-name")).toHaveText("renamed.txt");
    await expect(page.locator("#preview-content")).toHaveText("Synthetic preview text");
    await assert.rejects(fs.stat(path.join(workspace, "redacted/notes.txt")), { code: "ENOENT" });

    // Context-click and keyboard access use the same menu and naming dialog.
    await row("redacted").click({ button: "right" });
    await expect.poll(() => menuItems(app)).toContainEqual({ id: "new-folder", role: null, enabled: true });
    await selectMenu(app, "new-folder");
    await page.locator("#file-name-input").fill("Archive");
    await page.locator("#file-name-submit").click();
    await expect(row("redacted/Archive")).toBeVisible();

    await internalDrop(page, "redacted/renamed.txt", "redacted/Archive");
    await expect(row("redacted/Archive/renamed.txt")).toBeVisible();
    await expect(page.locator("#preview-content")).toHaveText("Synthetic preview text");
    assert.equal(await fs.readFile(path.join(workspace, "redacted/Archive/renamed.txt"), "utf8"), "Synthetic preview text");
    await internalDrop(page, "redacted/Archive", "redacted/Reports");
    await expect(row("redacted/Reports/Archive/renamed.txt")).toBeVisible();
    await expect(page.locator("#preview-content")).toHaveText("Synthetic preview text");
    await app.evaluate(() => { global.__fileMenu = null; });
    await row("redacted/Reports/Archive/renamed.txt").focus();
    await row("redacted/Reports/Archive/renamed.txt").press("Shift+F10");
    await expect.poll(() => menuItems(app)).toContainEqual({ id: "move", role: null, enabled: true });
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, path.join(workspace, "redacted"));
    await selectMenu(app, "move");
    await expect(row("redacted/renamed.txt")).toBeVisible();
    await expect(row("redacted/Reports/Archive/renamed.txt")).toHaveCount(0);

    await row("redacted/renamed.txt").focus();
    await row("redacted/renamed.txt").press("F2");
    await expect(page.locator("#file-dialog")).toBeVisible();
    await page.locator("#file-name-input").fill("report.csv");
    await page.locator("#file-name-submit").click();
    await expect(page.locator("#toast")).toContainText("already exists");
    assert.equal(await fs.readFile(path.join(workspace, "redacted/report.csv"), "utf8"), "id,amount\n0001,-1.20\n");

    // A selected source must be reselected after a filesystem edit.
    await page.locator("#database-skill").click();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, await fs.realpath(path.join(workspace, "redacted/report.csv")));
    await page.locator("#redact-choose").click();
    await expect(page.locator("#redaction-source")).toContainText("report.csv");
    const selection = await page.evaluate(() => window.arma.selectDatabaseSource("redacted/report.csv"));
    await row("redacted/report.csv").focus();
    await row("redacted/report.csv").press("F2");
    await page.locator("#file-name-input").fill("report-renamed.csv");
    await page.locator("#file-name-submit").click();
    await expect(row("redacted/report-renamed.csv")).toBeVisible();
    await expect(page.locator("#redaction-source")).toBeHidden();
    assert.match(await page.evaluate(async id => {
      try { await window.arma.start({ provider: "claude", skill: "database", sourceId: id, prompt: "Synthetic" }); }
      catch (error) { return error.message; }
    }, selection.id), /Choose the report again/);

    await internalDrop(page, "unredacted/private.txt", "redacted");
    await expect(row("redacted/private.txt")).toBeVisible();
    await expect(row("unredacted/private.txt")).toHaveCount(0);
    assert.equal(await fs.readFile(path.join(workspace, "redacted/private.txt"), "utf8"), "Synthetic protected original");
    await assert.rejects(fs.stat(path.join(workspace, "unredacted/private.txt")), { code: "ENOENT" });
    await internalDrop(page, "redacted/private.txt", "unredacted");
    await expect(row("unredacted/private.txt")).toBeVisible();
    await internalDrop(page, "unredacted/private.txt", "redacted/Reports");
    await expect(row("redacted/Reports/private.txt")).toBeVisible();
    assert.equal(await fs.readFile(path.join(workspace, "redacted/Reports/private.txt"), "utf8"), "Synthetic protected original");

    // Check native editing menus and preserve selection when using the icon.
    await page.locator("#prompt").fill("Synthetic editable text");
    await page.locator("#prompt").evaluate(element => { element.focus(); element.setSelectionRange(0, 9); });
    await page.locator("#edit-prompt").click();
    await expect.poll(async () => (await menuItems(app))?.filter(item => item.enabled).map(item => item.role)).toContain("paste");
    assert((await menuItems(app)).some(item => item.role === "copy" && item.enabled));
    assert.deepEqual(await page.locator("#prompt").evaluate(element => [element.selectionStart, element.selectionEnd]), [0, 9]);
    await app.evaluate(() => { global.__fileMenu = null; });
    await page.locator("#prompt").click({ button: "right" });
    await expect.poll(async () => (await menuItems(app))?.map(item => item.role)).toContain("paste");

    await page.evaluate(() => {
      const thread = conversation();
      thread.messages.push({ role: "assistant", text: "Synthetic response to copy" });
      renderMessages();
    });
    await page.locator(".message .message-actions").click();
    await expect.poll(() => menuItems(app)).toContainEqual({ id: undefined, role: "copy", enabled: true });
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "Synthetic response to copy");
    assert(!(await menuItems(app)).some(item => item.role === "paste"));

    // Mutations remain blocked during an active provider turn, even via IPC.
    await app.evaluate(({ app }) => {
      const requireApp = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
      const { AgentBridge } = requireApp("./agents.cjs");
      AgentBridge.prototype.start = async function () { this.starting = true; return { runId: "held" }; };
    });
    await page.evaluate(() => window.arma.start({ provider: "claude", prompt: "Hold synthetic query" }));
    assert.match(await page.evaluate(async () => {
      try { await window.arma.rename("redacted/renamed.txt", "blocked.txt"); }
      catch (error) { return error.message; }
    }), /Stop the agent turn/);
    assert.deepEqual(errors, []);
    await expect(page.locator("#toast")).toBeHidden({ timeout: 10000 });
    await page.screenshot({ path: path.join(temporary, "files-and-chat.png") });
    console.log(`Sidebar and chat menus smoke passed. Synthetic artifacts: ${temporary}`);
    console.log("Native menu contents and editing roles checked; system clipboard was left untouched.");
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
