"use strict";
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Menu,
  Notification,
} = require("electron");
// Match the software-rendering startup workaround on the Windows test laptop.
// Electron requires this before app readiness and before creating any windows.
if (process.platform === "win32") app.disableHardwareAcceleration();
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Workspace, movablePath } = require("./workspace.cjs");
const { fileMenuItems, editMenuItems } = require("./context-menus.cjs");
const { AgentBridge } = require("./agents.cjs");
const { ClaudeAuth } = require("./claude-auth.cjs");
const { SessionStore } = require("./sessions.cjs");
const { QueryNotifications, configureNotifications } = require("./notifications.cjs");
const { DocumentPreview } = require("./document-preview.cjs");
const { RedactionService } = require("./redaction.cjs");
const { DatabaseService } = require("./database.cjs");
const { UnredactionService } = require("./unredaction.cjs");
const { pathParts } = require("./workspace-tools.cjs");
const { REDACTION_PLACEHOLDER, DATABASE_PLACEHOLDER, PATIENT_SUMMARY_PLACEHOLDER, UNREDACTION_PLACEHOLDER } = require("./skills.cjs");
const documents = new DocumentPreview();
let previewRequest = 0;

if (process.env.ARM_USER_DATA)
  app.setPath("userData", path.resolve(process.env.ARM_USER_DATA));
app.setName("ARMa");
configureNotifications(app);
const sessions = new SessionStore(path.join(app.getPath("userData"), "sessions"));
let sessionsFlushed = false, flushingSessions = false;
let window,
  workspace,
  watcher,
  refreshTimer,
  agents,
  allowCodex = false,
  changingWorkspace = false,
  editingFiles = false,
  importing = false;
const notifications = new QueryNotifications({ Notification, getWindow: () => window });
let redactions;
let databases;
let unredactions;
let importController,
  quitAfterImport = false;
let recent = [];
const rendererURL = pathToFileURL(
  path.join(__dirname, "renderer/index.html"),
).href;
const recentPath = () => path.join(app.getPath("userData"), "workspaces.json");
const send = (channel, data) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
};
const claudeAuth = new ClaudeAuth({
  resolveBinary: async () => {
    const info = await agents.detect("claude");
    return info.available ? info.binary : null;
  },
  emit: state => send("auth:changed", state),
  openExternal: url => shell.openExternal(url),
});
async function providerStatus(refresh = false) {
  const providers = await agents.status(refresh);
  const auth = await claudeAuth.refresh();
  return providers.map(item => item.id === "claude" ? { ...item, auth } : item);
}
const current = () => {
  if (!workspace) throw new Error("Open a workspace first.");
  return workspace;
};
function register(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== rendererURL
    )
      throw new Error("Untrusted request.");
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return {
        ok: false,
        error: error.message || "The action could not be completed.",
      };
    }
  });
}
async function setWorkspace(operation) {
  if (changingWorkspace || importing || editingFiles)
    throw new Error("Wait for the current file operation to finish.");
  changingWorkspace = true;
  try {
    const next = new Workspace();
    const info = await operation(next);
    if (!info) return null;
    const savedSessions = await sessions.view(info.path);
    const savedHistory = await sessions.history(info.path);
    const nextRecent = [
      info,
      ...recent.filter((item) => item.path !== info.path),
    ].slice(0, 8);
    await fsp.mkdir(app.getPath("userData"), { recursive: true });
    await fsp.writeFile(recentPath(), JSON.stringify(nextRecent), {
      mode: 0o600,
    });
    agents.dispose();
    notifications.clear();
    redactions?.dispose();
    databases?.dispose();
    unredactions?.dispose();
    documents.clear();
    previewRequest++;
    agents = new AgentBridge({ allowCodex });
    agents.history = savedHistory;
    watcher?.close();
    clearTimeout(refreshTimer);
    workspace = next;
    redactions = new RedactionService(workspace, () =>
      send("workspace:changed", { path: next.root }),
    );
    databases = new DatabaseService(workspace, () => send("workspace:changed", { path: next.root }));
    unredactions = new UnredactionService(workspace, () => send("workspace:changed", { path: next.root }));
    recent = nextRecent;
    const changed = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(
        () => send("workspace:changed", { path: info.path }),
        160,
      );
    };
    try {
      watcher = fs.watch(info.path, { recursive: true }, changed);
      watcher.on("error", changed);
    } catch {
      try {
        watcher = fs.watch(info.path, changed);
        watcher.on("error", changed);
      } catch {
        watcher = null;
      }
    }
    return { ...info, sessions: savedSessions };
  } finally {
    changingWorkspace = false;
  }
}
async function importTo(sourcePaths, destination) {
  if (changingWorkspace || importing || editingFiles)
    throw new Error("Wait for the current file operation to finish.");
  if (agents.starting || agents.runs.size)
    throw new Error("Stop the agent turn before adding files.");
  const target = current();
  importing = true;
  importController = new AbortController();
  try {
    return await target.importPaths(sourcePaths, destination, {
      signal: importController.signal,
    });
  } finally {
    importing = false;
    importController = null;
    send("workspace:changed", { path: target.root });
    if (quitAfterImport) app.quit();
  }
}
async function editFiles(operation) {
  if (changingWorkspace || importing || editingFiles)
    throw new Error("Wait for the current file operation to finish.");
  if (agents.starting || agents.runs.size)
    throw new Error("Stop the agent turn before changing files.");
  const target = current();
  editingFiles = true;
  try {
    const result = await operation(target);
    if (result.changed) {
      documents.clear();
      previewRequest++;
      redactions?.dispose();
      databases?.dispose();
      unredactions?.dispose();
    }
    return result;
  } finally {
    editingFiles = false;
    send("workspace:changed", { path: target.root });
    if (quitAfterImport) app.quit();
  }
}
function installIPC() {
  const selectedRelative = async (root, filename) => {
    // macOS dialogs can return /var/... for a canonical /private/var workspace.
    // Normalize only its root alias; retain links inside it for rejection by
    // the workspace resolver instead of following a selected private link.
    for (let ancestor = path.resolve(filename); ; ancestor = path.dirname(ancestor)) {
      if (await fsp.realpath(ancestor) === root) return path.relative(ancestor, filename).split(path.sep).join("/");
      if (path.dirname(ancestor) === ancestor) throw new Error("Choose files inside the current workspace.");
    }
  };
  register("sessions:save", (root, view) => {
    if (root !== current().root) throw new Error("The workspace changed before sessions could be saved.");
    return sessions.saveView(root, view);
  });
  register("app:state", async () => ({
    recent,
    workspace: workspace
      ? { path: workspace.root, name: path.basename(workspace.root) }
      : null,
    providers: await providerStatus(),
    platform: process.platform,
    redactionPlaceholder: REDACTION_PLACEHOLDER,
    databasePlaceholder: DATABASE_PLACEHOLDER,
    patientSummaryPlaceholder: PATIENT_SUMMARY_PLACEHOLDER,
    unredactionPlaceholder: UNREDACTION_PLACEHOLDER,
  }));
  register("workspace:open", async () =>
    setWorkspace(async (next) => {
      const result = await dialog.showOpenDialog(window, {
        title: "Open workspace",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : next.open(result.filePaths[0]);
    }),
  );
  register("workspace:create", async () =>
    setWorkspace(async (next) => {
      const result = await dialog.showSaveDialog(window, {
        title: "New workspace",
        buttonLabel: "Create workspace",
        defaultPath: path.join(app.getPath("documents"), "Untitled workspace"),
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return result.canceled || !result.filePath
        ? null
        : next.create(
            path.dirname(result.filePath),
            path.basename(result.filePath),
          );
    }),
  );
  register("workspace:recent", async (selected) => {
    if (
      typeof selected !== "string" ||
      !recent.some((item) => item.path === selected)
    )
      throw new Error("Choose a recent workspace from the list.");
    return setWorkspace((next) => next.open(selected));
  });
  register("files:list", (relative) => current().list(relative));
  register("files:rename", (relative, name) => editFiles(target => target.rename(relative, name)));
  register("files:move", (relative, destination) => editFiles(target => target.move(relative, destination)));
  register("files:create-folder", (destination, name) => editFiles(target => target.createFolder(destination, name)));
  register("files:destination", async (relative) => {
    const selectedWorkspace = current();
    const source = await selectedWorkspace.resolve(relative);
    const result = await dialog.showOpenDialog(window, {
      title: "Move to folder", buttonLabel: "Move here", defaultPath: path.dirname(source),
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    if (selectedWorkspace !== workspace) throw new Error("The workspace changed. Choose the destination again.");
    const chosen = result.filePaths[0];
    const stat = await fsp.lstat(chosen);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Choose a regular destination folder.");
    const destination = path.relative(selectedWorkspace.root, await fsp.realpath(chosen)).split(path.sep).join("/");
    await selectedWorkspace.resolve(destination);
    return destination;
  });
  register("files:menu", async (relative) => {
    const target = current();
    const absolute = await target.resolve(relative);
    const items = fileMenuItems({
      movable: movablePath(relative), directory: (await fsp.lstat(absolute)).isDirectory(),
      canCreate: movablePath(relative) || ["", "redacted", "unredacted"].includes(relative),
      busy: editingFiles || importing || changingWorkspace || agents.starting || agents.runs.size > 0,
      revealLabel: process.platform === "darwin" ? "Reveal in Finder" : "Reveal in file manager",
    });
    return new Promise(resolve => {
      let action = null;
      const menu = Menu.buildFromTemplate(items.map(item => ({ ...item, click: () => { action = item.id; } })));
      menu.popup({ window, callback: () => resolve(target === workspace ? action : null) });
    });
  });
  register("edit:menu", (options) => {
    const items = editMenuItems({ editable: options?.editable === true, selection: options?.selection === true });
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });
  register("files:preview", async (relative, sheetIndex = -1) => {
    if (!Number.isInteger(sheetIndex) || sheetIndex < -1 || sheetIndex >= 64)
      throw new Error("Invalid worksheet selection.");
    const request = ++previewRequest;
    documents.cancel();
    const selected = current();
    const file = await selected.preview(relative);
    if (selected !== workspace || request !== previewRequest)
      throw new Error("Preview cancelled.");
    return documents.load(file, sheetIndex);
  });
  register("files:cancel-preview", () => {
    previewRequest++;
    documents.cancel();
  });
  register("files:cancel", () => {
    importController?.abort();
    return !!importController;
  });
  register("files:reveal", async (relative) => {
    shell.showItemInFolder(await current().resolve(relative));
  });
  register("files:pick", async (destination) => {
    const selectedWorkspace = current();
    const result = await dialog.showOpenDialog(window, {
      title: "Add files to workspace",
      buttonLabel: "Add files",
      properties: ["openFile", "openDirectory", "multiSelections"],
    });
    if (result.canceled) return null;
    if (selectedWorkspace !== current())
      throw new Error("The workspace changed. Choose the files again.");
    return importTo(result.filePaths, destination);
  });
  register("files:drop", (paths, destination) => importTo(paths, destination));
  register("redactions:sources", () => {
    current();
    return redactions.sources();
  });
  register("redactions:select", (relative) => {
    current();
    return redactions.select(relative);
  });
  register("redactions:pick", async () => {
    const selectedWorkspace = current();
    const result = await dialog.showOpenDialog(window, {
      title: "Choose a file to redact",
      buttonLabel: "Choose file",
      defaultPath: path.join(selectedWorkspace.root, "unredacted"),
      properties: ["openFile"],
      filters: [
        {
          name: "Excel and text",
          extensions: [
            "xlsx",
            "csv",
            "tsv",
            "txt",
            "md",
            "log",
            "json",
            "jsonl",
            "xml",
            "yaml",
            "yml",
          ],
        },
      ],
    });
    if (result.canceled) return null;
    if (selectedWorkspace !== current())
      throw new Error("The workspace changed. Choose the file again.");
    const relative = path
      .relative(selectedWorkspace.root, result.filePaths[0])
      .split(path.sep)
      .join("/");
    if (relative.startsWith("unredacted/")) return redactions.select(relative);
    const imported = await importTo(result.filePaths, "unredacted");
    if (!imported.copied.length)
      throw new Error("The source could not be copied into unredacted.");
    return redactions.select(imported.copied[0]);
  });
  register("redactions:jobs", () => {
    current();
    return redactions.jobs();
  });
  register("databases:sources", () => { current(); return databases.sources(); });
  register("databases:select", relative => { current(); return databases.select(relative); });
  register("summaries:sources", async () => { current(); return (await databases.sources()).filter(s => /\.(sqlite|db)$/i.test(s.path)); });
  register("summaries:select", relative => {
    current();
    if (typeof relative !== "string" || !/\.(sqlite|db)$/i.test(relative)) throw new Error("Choose a saved SQLite database for patient summaries.");
    return databases.select(relative);
  });
  const pickDatabase = async (summaries = false) => {
    const selectedWorkspace = current();
    const result = await dialog.showOpenDialog(window, {
      title: summaries ? "Choose a patient database" : "Choose a redacted report", buttonLabel: "Choose file",
      defaultPath: path.join(selectedWorkspace.root,"redacted"), properties: ["openFile"],
      filters: [{ name: summaries ? "SQLite databases" : "Reports and databases", extensions: summaries ? ["sqlite","db"] : ["xlsx","csv","tsv","sqlite","db"] }],
    });
    if (result.canceled) return null;
    if (selectedWorkspace !== current()) throw new Error("The workspace changed. Choose the file again.");
    // Never move a protected original into agent access through this picker.
    const source = result.filePaths[0], canonical = await fsp.realpath(source);
    if (summaries && !/\.(sqlite|db)$/i.test(source)) throw new Error("Choose a saved SQLite database for patient summaries.");
    pathParts(source.split(path.sep).filter(Boolean).join("/"));
    pathParts(canonical.split(path.sep).filter(Boolean).join("/"));
    const relative = path.relative(selectedWorkspace.root,source).split(path.sep).join("/");
    if (relative.startsWith("redacted/")) return databases.select(relative);
    const imported = await importTo([source],"redacted");
    if (!imported.copied.length) throw new Error("The report could not be copied into redacted.");
    return databases.select(imported.copied[0]);
  };
  register("databases:pick", () => pickDatabase());
  register("summaries:pick", () => pickDatabase(true));
  register("unredactions:sources", () => { current(); return unredactions.sources(); });
  register("unredactions:select", relative => { current(); return unredactions.select(relative); });
  register("unredactions:pick", async () => {
    const selected = current();
    const result = await dialog.showOpenDialog(window, { title: "Choose patient summaries", defaultPath: path.join(selected.root, "redacted/Patient Summaries"), properties: ["openDirectory"] });
    if (result.canceled) return null;
    if (selected !== current()) throw new Error("The workspace changed. Choose the summaries again.");
    return unredactions.select(await selectedRelative(selected.root, result.filePaths[0]));
  });
  register("unredactions:mappings", async id => {
    const selected = current();
    const result = await dialog.showOpenDialog(window, { title: "Choose matching redaction mappings", defaultPath: path.join(selected.root, "unredacted/redaction-runs"), properties: ["openFile", "multiSelections"], filters: [{ name: "Redaction mapping CSVs", extensions: ["csv"] }] });
    if (result.canceled) return null;
    if (selected !== current()) throw new Error("The workspace changed. Choose the mappings again.");
    return unredactions.selectMappings(id, await Promise.all(result.filePaths.map(file => selectedRelative(selected.root, file))));
  });
  register("redactions:approve", (id) => {
    if (agents.starting || agents.runs.size || changingWorkspace || importing || editingFiles)
      throw new Error("Wait for the current operation before publishing.");
    current();
    return redactions.approve(id);
  });
  register("agents:status", () => providerStatus(true));
  register("auth:start", () => {
    if (agents.starting || agents.runs.size)
      throw new Error("Wait for the current response before signing in.");
    return claudeAuth.start();
  });
  register("auth:cancel", () => claudeAuth.cancel());
  register("auth:browser", () => claudeAuth.reopenBrowser());
  register("auth:code", code => claudeAuth.submitCode(code));
  register("agents:start", (args) => {
    if (changingWorkspace || importing || editingFiles)
      throw new Error("Wait for the current file operation to finish.");
    if (!args || typeof args !== "object") throw new Error("Enter a message.");
    if ((!args.provider || args.provider === "claude") && claudeAuth.pending)
      throw new Error("Finish or cancel Claude sign-in before sending a message.");
    if (args.skill && !["redact","database","patient-summaries","unredact-summaries"].includes(args.skill))
      throw new Error("That skill is unavailable.");
    const redaction =
      args.skill === "redact"
        ? redactions?.capability(args.sourceId)
        : undefined;
    if (args.skill === "redact" && !redaction)
      throw new Error("Choose a source file first.");
    if (["database", "patient-summaries", "unredact-summaries"].includes(args.skill) && !args.sourceId) throw new Error("Choose a report first.");
    const access = redaction ? undefined : args.skill === "unredact-summaries" ? unredactions.capability(args.sourceId) : args.skill === "patient-summaries" ? databases.summaryAccess(args.sourceId) : databases.agentAccess(
      `${args.provider || "claude"}:${args.conversationId || "default"}`,
      args.skill === "database" ? args.sourceId : undefined,
    );
    const bridge = agents;
    const root = current().root;
    const notifyCompletion = notifications.forQuery(args.provider);
    return agents.start(
      {
        provider: args.provider,
        model: args.model,
        effort: args.effort,
        prompt: args.prompt,
        conversationId: args.conversationId,
        workspace: current().root,
        redaction,
        access,
      },
      (event) => {
        if (event.type === "done" && agents === bridge && !bridge.disposed) {
          sessions.saveHistory(root, bridge.history).catch(() => send("sessions:error", "Could not save session context locally."));
        }
        send("agents:event", event);
        if (agents === bridge && !bridge.disposed) notifyCompletion(event);
      },
    );
  });
  register("agents:cancel", (runId) => agents.cancel(runId));
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "ARMa",
    backgroundColor: "#171719",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on("context-menu", (_event, params) => {
    const items = editMenuItems({ editable: params.isEditable, selection: !!params.selectionText, flags: params.editFlags });
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });
  window.on("closed", () => {
    claudeAuth.dispose();
    notifications.clear();
    documents.clear();
    redactions?.dispose();
    databases?.dispose();
    unredactions?.dispose();
    agents.dispose();
    watcher?.close();
    clearTimeout(refreshTimer);
    window = null;
  });
  await window.loadFile(path.join(__dirname, "renderer/index.html"));
}
app.whenReady().then(async () => {
  let hasCodex = false;
  try {
    require.resolve("@openai/codex/package.json");
    hasCodex = true;
  } catch {}
  allowCodex =
    !app.isPackaged && hasCodex && process.env.ARM_ENABLE_CODEX !== "0";
  agents = new AgentBridge({ allowCodex });
  try {
    const stored = JSON.parse(await fsp.readFile(recentPath(), "utf8"));
    recent = Array.isArray(stored)
      ? stored
          .filter(
            (item) =>
              typeof item?.path === "string" &&
              path.isAbsolute(item.path) &&
              typeof item.name === "string",
          )
          .slice(0, 8)
      : [];
  } catch {}
  installIPC();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "ARMa",
        submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  await createWindow();
  app.on("activate", () => {
    if (!window) createWindow();
  });
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  claudeAuth.dispose();
  if (importing || editingFiles) {
    event.preventDefault();
    quitAfterImport = true;
    importController?.abort();
  }
  if (!sessionsFlushed) {
    event.preventDefault();
    if (!flushingSessions) {
      flushingSessions = true;
      sessions.flush().catch(() => {}).finally(() => {
        sessionsFlushed = true;
        app.quit();
      });
    }
  }
  agents?.dispose();
  notifications.clear();
  watcher?.close();
});
