"use strict";

// Run against the real sandboxed Electron window. Only native pickers and model
// responses and notification delivery are replaced; filesystem IPC and native
// File paths remain real.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");

const project = path.resolve(__dirname, "..");
const errors = [];
let application;

async function launch(userData, extraEnv = {}) {
  const env = { ...process.env, ARM_USER_DATA: userData, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [path.join(project, "main.cjs")],
    cwd: project,
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("#model optgroup")).toHaveCount(
    extraEnv.ARM_ENABLE_CODEX === "0" ? 1 : 2,
    { timeout: 30000 },
  );
  return { app, page };
}

async function mockDialogs(app, results) {
  await app.evaluate(({ dialog }, next) => {
    dialog.showOpenDialog = async () =>
      next.open || { canceled: true, filePaths: [] };
    dialog.showSaveDialog = async () => next.save || { canceled: true };
  }, results);
}

async function installAgentFixture(app) {
  await app.evaluate(({ app, Notification }) => {
    const requireApp = process
      .getBuiltinModule("node:module")
      .createRequire(`${app.getAppPath()}/package.json`);
    const { AgentBridge } = requireApp("./agents.cjs");
    requireApp("./claude-auth.cjs").ClaudeAuth.prototype.readStatus = async () => true;
    const { CLAUDE_MODELS } = requireApp("./model-options.cjs");
    global.__armaSmoke = { calls: [], active: new Map(), serial: 0 };
    global.__armaNotifications = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      global.__armaNotifications.push(this);
    };
    Notification.prototype.close = function () {};
    AgentBridge.prototype.status = async function () {
      return [
        {
          id: "claude",
          name: "Claude Code",
          models: CLAUDE_MODELS,
          available: true,
          version: "smoke fixture",
        },
        ...(this.allowCodex
          ? [
              {
                id: "codex",
                name: "Codex · testing",
                models: [{ id: "gpt-6-astra", name: "GPT-6 Astra", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }],
                available: true,
                version: "smoke fixture",
              },
            ]
          : []),
      ];
    };
    AgentBridge.prototype.start = async function (args, emit) {
      // Keep the lifecycle guard: opening a workspace must not leave a disposed bridge.
      if (this.disposed) throw new Error("The agent connection is closed.");
      if (args.provider === "codex" && !this.allowCodex)
        throw new Error("This agent is not available.");
      const state = global.__armaSmoke;
      state.calls.push({ ...args });
      const runId = `smoke-${++state.serial}`;
      this.runs.set(runId, {});
      const send = (event) => emit({ runId, ...event });
      // A synchronous event exercises the renderer's pre-response event queue.
      send({ type: "status", text: "Reading workspace…" });
      send({
        type: "delta",
        text: `${args.provider === "claude" ? "Claude" : "Codex"} inspected `,
      });
      const finish = () => {
        state.active.delete(runId);
        this.runs.delete(runId);
        send({ type: "delta", text: "the selected workspace." });
        send({ type: "done", cancelled: false, failed: false });
      };
      const timer =
        args.prompt === "Keep working until stopped"
          ? null
          : setTimeout(finish, 150);
      state.active.set(runId, { send, timer, bridge: this });
      return { runId };
    };
    AgentBridge.prototype.cancel = function (runId) {
      const run = global.__armaSmoke.active.get(runId);
      if (!run) return false;
      clearTimeout(run.timer);
      global.__armaSmoke.active.delete(runId);
      run.bridge.runs.delete(runId);
      run.send({ type: "done", cancelled: true, failed: false });
      return true;
    };
  });
}

async function nativeFileDrop(page, source, destination) {
  // setInputFiles creates a browser File backed by a real local path. Constructing
  // new File([...]) would incorrectly bypass Electron webUtils.getPathForFile.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "smoke-native-file";
    input.type = "file";
    input.hidden = true;
    document.body.append(input);
  });
  await page.locator("#smoke-native-file").setInputFiles(source);
  await page.evaluate((destination) => {
    const input = document.getElementById("smoke-native-file");
    const transfer = new DataTransfer();
    for (const file of input.files) transfer.items.add(file);
    const row = [...document.querySelectorAll(".tree-row")].find(
      (item) => item.dataset.path === destination,
    );
    if (!row) throw new Error(`Missing drop destination: ${destination}`);
    row.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    row.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    input.remove();
  }, destination);
  await expect(page.locator("#file-status")).toHaveText("1 item added");
  await expect(page.locator("#add-files")).toBeEnabled();
}

async function send(page, prompt) {
  await page.locator("#prompt").fill(prompt);
  await expect(page.locator("#send")).toBeEnabled();
  await page.locator("#prompt").press("Enter");
}

(async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "arma-electron-smoke-"),
  );
  const fixtures = path.join(temporary, "incoming");
  const workspace = path.join(temporary, "Synthetic claims");
  const otherWorkspace = path.join(temporary, "Existing workspace");
  const userData = path.join(temporary, "app-data");
  const csv = "patient,amount\nSynthetic Patient,123.45\n";
  const localOnly =
    "<script>window.__previewExecuted = true</script>\nSynthetic protected content.\n";
  await fs.mkdir(path.join(fixtures, "Supporting notes"), { recursive: true });
  await fs.mkdir(otherWorkspace);
  await fs.writeFile(path.join(fixtures, "claims.csv"), csv);
  await fs.writeFile(path.join(fixtures, "private.html"), localOnly);
  await fs.writeFile(
    path.join(fixtures, "Supporting notes", "context.txt"),
    "Synthetic supporting notes.",
  );

  try {
    let launched = await launch(userData);
    application = launched.app;
    let page = launched.page;
    const actualProviders = await page.evaluate(() => window.arma.providers());
    assert.deepEqual(
      actualProviders.map((provider) => provider.id),
      ["claude", "codex"],
    );
    assert(
      actualProviders.every(
        (provider) => typeof provider.available === "boolean",
      ),
    );
    console.log("Installed CLI detection:", JSON.stringify(actualProviders));

    assert.deepEqual(
      await page.evaluate(() => ({
        require: typeof require,
        process: typeof process,
        api: typeof window.arma?.dropFiles,
      })),
      { require: "undefined", process: "undefined", api: "function" },
    );
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const preferences =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      };
    });
    assert.deepEqual(preferences, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    await expect(page.locator("#prompt")).toBeDisabled();
    await expect(page.locator("#add-files")).toBeDisabled();
    await page.screenshot({ path: path.join(temporary, "welcome.png") });

    await installAgentFixture(application);
    await page.locator("#connections").click();
    await page.locator("#refresh-connections").click();
    await expect(page.locator(".connection-state")).toHaveText([
      "Signed in",
      "CLI installed",
    ]);
    await page.locator("#close-connections").click();
    await mockDialogs(application, {
      save: { canceled: false, filePath: workspace },
    });
    await page.locator("#welcome-create").click();
    await expect(page.locator("#workspace-name")).toHaveText(
      "Synthetic claims",
    );
    await expect(page.locator("#prompt")).toBeEnabled();
    assert((await fs.stat(path.join(workspace, "unredacted"))).isDirectory());
    assert((await fs.stat(path.join(workspace, "redacted"))).isDirectory());
    await expect(
      page.locator('.tree-row[data-path="unredacted"]'),
    ).toHaveAttribute("title", /excluded from agent access/);

    // System metadata stays on disk but is hidden at every level of the sidebar.
    for (const folder of ["", "unredacted"]) {
      for (const name of [
        ".DS_Store",
        "._claims.csv",
        "Thumbs.db",
        "desktop.ini",
        "~$draft.docx",
      ]) {
        await fs.writeFile(
          path.join(workspace, folder, name),
          "Synthetic system metadata",
        );
      }
      await fs.mkdir(path.join(workspace, folder, "__MACOSX"));
    }
    await fs.writeFile(
      path.join(workspace, ".workspace-notes"),
      "Keep useful dotfiles visible",
    );
    await page.locator("#refresh-files").click();
    await expect(
      page.locator('.tree-row[data-path=".workspace-notes"]'),
    ).toBeVisible();
    for (const folder of ["", "unredacted"]) {
      for (const name of [
        ".DS_Store",
        "._claims.csv",
        "Thumbs.db",
        "desktop.ini",
        "~$draft.docx",
        "__MACOSX",
      ]) {
        await expect(
          page.locator(
            `.tree-row[data-path="${folder ? `${folder}/` : ""}${name}"]`,
          ),
        ).toHaveCount(0);
        assert(await fs.stat(path.join(workspace, folder, name)));
      }
    }

    // Pick a file and a folder, then add the same file again without overwriting it.
    await mockDialogs(application, {
      open: {
        canceled: false,
        filePaths: [
          path.join(fixtures, "claims.csv"),
          path.join(fixtures, "Supporting notes"),
        ],
      },
    });
    await page.locator("#add-files").click();
    await expect(page.locator("#file-status")).toHaveText("2 items added");
    await expect(
      page.locator('.tree-row[data-path="unredacted/claims.csv"]'),
    ).toBeVisible();
    await page
      .locator('.tree-row[data-path="unredacted/Supporting notes"]')
      .click();
    await page
      .locator('.tree-row[data-path="unredacted/Supporting notes/context.txt"]')
      .click();
    await expect(page.locator("#preview-content")).toHaveText(
      "Synthetic supporting notes.",
    );
    await page.locator("#close-preview").click();
    // Selecting the parent also collapses it; importing reopens that destination.
    await page.locator('.tree-row[data-path="unredacted"]').click();
    await mockDialogs(application, {
      open: { canceled: false, filePaths: [path.join(fixtures, "claims.csv")] },
    });
    await page.locator("#add-files").click();
    await expect(
      page.locator('.tree-row[data-path="unredacted/claims (2).csv"]'),
    ).toBeVisible();
    assert.equal(
      await fs.readFile(
        path.join(workspace, "unredacted", "claims.csv"),
        "utf8",
      ),
      csv,
    );
    assert.equal(
      await fs.readFile(
        path.join(workspace, "unredacted", "claims (2).csv"),
        "utf8",
      ),
      csv,
    );

    await nativeFileDrop(page, path.join(fixtures, "private.html"), "redacted");
    await expect(
      page.locator('.tree-row[data-path="redacted/private.html"]'),
    ).toBeVisible();
    await page.locator('.tree-row[data-path="redacted/private.html"]').click();
    await expect(page.locator("#preview-content")).toHaveText(localOnly);
    assert.equal(
      await page.evaluate(() => window.__previewExecuted),
      undefined,
    );
    assert.equal(
      await fs.readFile(
        path.join(workspace, "redacted", "private.html"),
        "utf8",
      ),
      localOnly,
    );
    await nativeFileDrop(
      page,
      path.join(fixtures, "private.html"),
      "unredacted",
    );
    await expect(
      page.locator('.tree-row[data-path="unredacted/private.html"]'),
    ).toBeVisible();
    assert.equal(
      await fs.readFile(
        path.join(workspace, "unredacted", "private.html"),
        "utf8",
      ),
      localOnly,
    );
    assert.equal(
      await fs.readFile(path.join(fixtures, "private.html"), "utf8"),
      localOnly,
    );

    // Hold a real import mid-operation to exercise both renderer and main-process
    // exclusion of agent turns while the selected workspace is being modified.
    await application.evaluate(({ app }) => {
      const requireApp = process
        .getBuiltinModule("node:module")
        .createRequire(`${app.getAppPath()}/package.json`);
      const { Workspace } = requireApp("./workspace.cjs");
      const original = Workspace.prototype.importPaths;
      Workspace.prototype.importPaths = async function (...args) {
        Workspace.prototype.importPaths = original;
        global.__armaSmoke.importOptions = args[2];
        await new Promise((resolve) => {
          global.__armaSmoke.resumeImport = resolve;
        });
        const result = await original.apply(this, args);
        global.__armaSmoke.importResult = result;
        return result;
      };
    });
    await page.locator("#prompt").fill("Wait for the import");
    await page.locator("#add-files").click();
    await expect(page.locator("#file-status")).toHaveText("Adding files…");
    await expect(page.locator("#send")).toBeDisabled();
    await expect(page.locator("#open-workspace")).toBeDisabled();
    const pendingImportError = await page.evaluate(async () => {
      try {
        await window.arma.start({
          provider: "claude",
          prompt: "Blocked during import",
          conversationId: "import-test",
        });
        return "unexpected turn";
      } catch (error) {
        return error.message;
      }
    });
    assert.match(pendingImportError, /file operation/);
    await expect(page.locator("#cancel-import")).toBeVisible();
    await page.locator("#cancel-import").click();
    await expect
      .poll(() =>
        application.evaluate(
          () => global.__armaSmoke.importOptions.signal.aborted,
        ),
      )
      .toBe(true);
    await application.evaluate(() => global.__armaSmoke.resumeImport());
    await expect(page.locator("#file-status")).toHaveText(
      "0 items added · Import cancelled",
    );
    await expect(page.locator("#cancel-import")).toBeHidden();
    await expect(page.locator("#add-files")).toBeEnabled();
    await expect(page.locator("#open-workspace")).toBeEnabled();
    await expect(page.locator("#send")).toBeEnabled();
    assert.deepEqual(
      await application.evaluate(() => global.__armaSmoke.importResult),
      { copied: [], skipped: [], cancelled: true },
    );
    await assert.rejects(
      fs.stat(path.join(workspace, "unredacted", "claims (3).csv")),
      { code: "ENOENT" },
    );
    // A cancelled operation must release both UI and main-process import locks.
    await page.locator("#add-files").click();
    await expect(
      page.locator('.tree-row[data-path="unredacted/claims (3).csv"]'),
    ).toBeVisible();
    await expect(page.locator("#cancel-import")).toBeHidden();

    const traversal = await page.evaluate(async () => {
      try {
        await window.arma.preview("../incoming/claims.csv");
        return "unexpected access";
      } catch (error) {
        return error.message;
      }
    });
    assert.match(traversal, /cannot leave|inside the working directory/);

    await page.getByLabel("Model", { exact: true }).selectOption("claude:sonnet");
    await page.getByLabel("Reasoning effort").selectOption("high");
    await expect(page.locator("#toast")).toBeHidden({ timeout: 10000 });
    await page.locator("#prompt").fill("");
    await page.locator("#composer").screenshot({ path: path.join(temporary, "model-selectors.png") });
    await send(page, "Summarize the workspace files");
    await expect(page.locator(".message.assistant .message-body")).toHaveText(
      "Claude inspected the selected workspace.",
    );
    await expect(page.locator("#stop")).toBeHidden();
    assert.deepEqual(await application.evaluate(() => global.__armaNotifications.map(n => ({ title: n.title, body: n.body }))), [
      { title: "ARMa", body: "Claude query complete. Your response is ready." },
    ]);
    await page.locator("#model").selectOption("codex:gpt-6-astra");
    await expect(page.locator("#messages .message")).toHaveCount(0);
    await expect(page.getByLabel("Reasoning effort")).toHaveValue("medium");
    await page.getByLabel("Reasoning effort").selectOption("xhigh");
    await send(page, "Check the supporting notes");
    await expect(page.locator(".message.assistant .message-body")).toHaveText(
      "Codex inspected the selected workspace.",
    );
    await expect(page.locator("#stop")).toBeHidden();
    assert.equal(await application.evaluate(() => global.__armaNotifications[1].body), "Codex query complete. Your response is ready.");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    await application.evaluate(() => global.__armaNotifications[1].emit("click"));
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return !window.isMinimized() && window.isVisible() && window.isFocused();
    })).toBe(true);
    await page.locator("#model").selectOption("claude:sonnet");
    await expect(page.locator(".message.user .message-body")).toHaveText(
      "Summarize the workspace files",
    );
    await page.getByLabel("Model", { exact: true }).selectOption("claude:haiku");
    await expect(page.getByLabel("Reasoning effort")).toBeDisabled();
    await expect(page.getByLabel("Reasoning effort")).toHaveValue("");
    await page.getByLabel("Model", { exact: true }).selectOption("claude:opus");
    await page.getByLabel("Reasoning effort").selectOption("max");
    await send(page, "Keep working until stopped");
    await expect(page.locator("#stop")).toBeEnabled();
    await expect(page.locator("#model")).toBeDisabled();
    await expect(page.locator("#effort")).toBeDisabled();
    await expect(page.locator("#open-workspace")).toBeDisabled();
    await expect(page.locator("#add-files")).toBeDisabled();
    const activeTurnError = await page.evaluate(async () => {
      try {
        await window.arma.pickFiles("unredacted");
        return "unexpected import";
      } catch (error) {
        return error.message;
      }
    });
    assert.match(activeTurnError, /Stop the agent turn/);
    await page.locator("#stop").click();
    await expect(page.locator("#stop")).toBeHidden();
    await expect(page.locator("#activity")).toHaveText("Stopped");
    assert.equal(await application.evaluate(() => global.__armaNotifications.length), 2);
    await page.locator("#new-conversation").click();
    await expect(page.locator("#messages .message")).toHaveCount(0);
    await send(page, "Start a fresh review");
    await expect(page.locator(".message.assistant .message-body")).toHaveText(
      "Claude inspected the selected workspace.",
    );
    await expect(page.locator("#stop")).toBeHidden();

    const calls = await application.evaluate(() => global.__armaSmoke.calls);
    assert.deepEqual(
      calls.map((call) => call.provider),
      ["claude", "codex", "claude", "claude"],
    );
    assert.deepEqual(calls.slice(0, 3).map(({ model, effort }) => ({ model, effort })), [
      { model: "sonnet", effort: "high" },
      { model: "gpt-6-astra", effort: "xhigh" },
      { model: "opus", effort: "max" },
    ]);
    const canonicalWorkspace = await fs.realpath(workspace);
    assert(calls.every((call) => call.workspace === canonicalWorkspace));
    assert.equal(calls[0].conversationId, calls[2].conversationId);
    assert.notEqual(calls[0].conversationId, calls[1].conversationId);
    assert.notEqual(calls[0].conversationId, calls[3].conversationId);
    assert(!JSON.stringify(calls).includes("Synthetic protected content"));
    await page.locator('.tree-row[data-path="unredacted/claims.csv"]').click();
    await expect(page.locator('.sheet-cell[data-cell="B2"]')).toHaveText(
      "123.45",
    );
    await expect(
      page.locator('.tree-row[data-path="unredacted/claims.csv"]'),
    ).toHaveAttribute("aria-selected", "true");
    const updatedCsv = "patient,amount\nSynthetic Patient,456.78\n";
    await fs.writeFile(
      path.join(workspace, "unredacted", "claims.csv"),
      updatedCsv,
    );
    await expect(page.locator('.sheet-cell[data-cell="B2"]')).toHaveText(
      "456.78",
    );
    await expect(page.locator("#toast")).toBeHidden({ timeout: 10000 });
    await page.screenshot({ path: path.join(temporary, "workspace.png") });

    await mockDialogs(application, {
      open: { canceled: false, filePaths: [otherWorkspace] },
    });
    await page.locator("#open-workspace").click();
    await expect(page.locator("#workspace-name")).toHaveText(
      "Existing workspace",
    );
    await expect(page.locator("#messages .message")).toHaveCount(0);
    assert(
      (await fs.stat(path.join(otherWorkspace, "redacted"))).isDirectory(),
    );
    await send(page, "Review this workspace");
    await expect(page.locator(".message.assistant .message-body")).toHaveText(
      "Claude inspected the selected workspace.",
    );
    await expect(page.locator("#stop")).toBeHidden();

    // Native navigation and extra windows remain blocked even from the renderer.
    const originalURL = page.url();
    await page.evaluate(() => {
      window.open("about:blank");
      window.location.assign("about:blank");
    });
    await expect.poll(() => page.url()).toBe(originalURL);
    assert.equal((await application.windows()).length, 1);
    await application.close();
    application = null;

    // Development-only Codex is absent when explicitly disabled, and recent
    // workspaces and their saved sessions survive a real app restart.
    launched = await launch(userData, { ARM_ENABLE_CODEX: "0" });
    application = launched.app;
    page = launched.page;
    await expect(page.locator("#model optgroup")).toHaveAttribute("label", "Claude Code");
    await expect(page.locator("#model")).toHaveValue("claude:opus");
    await expect(page.locator("#effort")).toHaveValue("max");
    await expect(page.locator("#recent-list .recent-button")).toHaveCount(2);
    await page
      .locator("#recent-list .recent-button")
      .filter({ hasText: "Synthetic claims" })
      .click();
    await expect(page.locator("#workspace-name")).toHaveText(
      "Synthetic claims",
    );
    await expect(page.locator(".message.user .message-body")).toHaveText("Start a fresh review");
    await expect(page.locator(".message.assistant .message-body")).toHaveText("Claude inspected the selected workspace.");
    await expect(page.locator(".session-row")).toHaveCount(2);
    const codexError = await page.evaluate(async () => {
      try {
        await window.arma.start({
          provider: "codex",
          prompt: "This should be blocked",
          conversationId: "disabled-test",
        });
        return "unexpected access";
      } catch (error) {
        return error.message;
      }
    });
    assert.match(codexError, /not available/);
    assert.deepEqual(errors, []);
    console.log(`Electron smoke passed. Synthetic screenshots: ${temporary}`);
    console.log("Live authentication and model inference were not exercised.");
  } catch (error) {
    if (application) {
      const pages = application.windows();
      await pages[0]
        ?.screenshot({ path: path.join(temporary, "failure.png") })
        .catch(() => {});
    }
    console.error(`Smoke artifacts: ${temporary}`);
    throw error;
  } finally {
    if (application) await application.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
