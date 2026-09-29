"use strict";
const $ = (id) => document.getElementById(id);
const icons = {
  folder: '<path d="M3 5h6l2 2h10v12H3z"/>',
  folderOpen: '<path d="M3 18V5h6l2 2h9v3M3 19l3-9h16l-3 9z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
  compose:
    '<path d="M13 5H4v15h15v-9M15 4l3-3 5 5-3 3M10 14l2-6 6-6 5 5-6 6-7 1z"/>',
  sliders:
    '<path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  spark:
    '<path d="m12 2 2.6 6.7L22 12l-7.4 3.3L12 22l-2.6-6.7L2 12l7.4-3.3z"/>',
  arrowUp: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  file: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 13h8M8 17h6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4zM7 8h10M7 12h7"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
};
function icon(name, className = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("aria-hidden", "true");
  if (className) node.setAttribute("class", className);
  node.innerHTML = icons[name] || icons.file;
  return node;
}
document
  .querySelectorAll("[data-icon]")
  .forEach((node) => node.append(icon(node.dataset.icon)));
let workspace = null,
  providers = [],
  provider = "claude",
  model = "",
  effort = "",
  selectedFolder = "unredacted",
  selectedFile = null,
  previewPath = null;
let documentViewer = null,
  previewRevision = null,
  previewLoadingVersion = 0,
  pendingPreviewRefresh = false;
let redactionPlaceholder =
  "What should be redacted? For example: column B, or names and IDs in “Employee: Name (ID)” rows.";
let databasePlaceholder = "Describe how the file is laid out and how you want the data arranged in the database.";
let patientSummaryPlaceholder = "Create a concise Word summary for each patient in the selected database.";
let unredactionPlaceholder = "Create and run a local tool to unredact the selected patient summaries using the selected mapping CSVs.";
let sourceOptions = [],
  sourceOptionIndex = 0,
  mentionVersion = 0;
let redactionJobs = [],
  jobsVersion = 0;
function disposeDocumentViewer() {
  documentViewer?.destroy();
  documentViewer = null;
  previewRevision = null;
  $("preview-content").classList.remove("document");
}
let expanded = new Set(["", "unredacted", "redacted"]),
  treeVersion = 0,
  previewVersion = 0,
  fileBusy = false;
const internalDragType = "application/x-arma-workspace-item";
let draggedItem = null;
let conversations = new Map(),
  toastTimer,
  refreshTimer,
  providerLoading = true;
let workspaceSessions = [], activeSessionId = "", sidebarView = "files", sidebarCollapsed = false;
let lastSessionSave = Promise.resolve(), sessionSaveError = false;
function activeSession() {
  return workspaceSessions.find(item => item.id === activeSessionId);
}
function makeSession() {
  const session = { id: crypto.randomUUID(), title: "", provider, model, effort, conversations: new Map() };
  workspaceSessions.unshift(session);
  activeSessionId = session.id;
  conversations = session.conversations;
  return session;
}
function saveSessions() {
  const active = activeSession();
  if (!workspace || !active) return lastSessionSave;
  Object.assign(active, { provider, model, effort });
  const view = {
    activeId: activeSessionId,
    sessions: workspaceSessions.map(session => ({
      id: session.id, title: session.title, provider: session.provider, model: session.model, effort: session.effort,
      conversations: [...session.conversations].map(([provider, thread]) => ({
        id: thread.id, provider, draft: thread.draft,
        redact: thread.redact, database: thread.database, summaries: thread.summaries, unredact: thread.unredact,
        interrupted: !!thread.runId || thread.starting,
        messages: thread.messages.map(({ role, text }) => ({ role, text })),
      })),
    })),
  };
  lastSessionSave = window.arma.saveSessions(workspace.path, view).then(() => {
    sessionSaveError = false;
  }).catch(error => {
    if (!sessionSaveError) notify(error.message || "Could not save sessions locally.", true);
    sessionSaveError = true;
  });
  return lastSessionSave;
}
function restoreSessions(saved) {
  workspaceSessions = (saved?.sessions || []).map(session => ({
    ...session,
    conversations: new Map(session.conversations.map(thread => {
      const messages = thread.messages.map(message => ({ ...message }));
      if (thread.interrupted) {
        if (messages.at(-1)?.role === "assistant" && !messages.at(-1).text) messages.pop();
        messages.push({ role: "stopped", text: "Interrupted when the app closed. Send a message to continue." });
      }
      return [thread.provider, { ...thread, messages, runId: null, starting: false, pending: [], activity: "", source: null }];
    })),
  }));
  activeSessionId = saved?.activeId || "";
  const session = activeSession() || makeSession();
  conversations = session.conversations;
  ({ provider, model, effort } = session);
  renderModelOptions();
  providerIndicator();
}
function sessionBusy() {
  return fileBusy || [...conversations.values()].some(thread => thread.runId || thread.starting);
}
function renderSessions() {
  $("session-list").replaceChildren();
  if (!workspace) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No workspace open";
    $("session-list").append(empty);
  }
  for (const session of workspaceSessions) {
    const button = document.createElement("button");
    button.className = "session-row";
    button.dataset.sessionId = session.id;
    button.setAttribute("aria-current", String(session.id === activeSessionId));
    button.disabled = sessionBusy();
    button.title = session.title || "New session";
    const title = document.createElement("span");
    title.textContent = button.title;
    button.append(icon("chat"), title);
    button.onclick = () => selectSession(session.id);
    $("session-list").append(button);
  }
}
function selectSession(id) {
  if (sessionBusy() || id === activeSessionId) return;
  const session = workspaceSessions.find(item => item.id === id);
  if (!session) return;
  saveSessions();
  activeSessionId = id;
  conversations = session.conversations;
  ({ provider, model, effort } = session);
  renderModelOptions();
  providerIndicator();
  saveModelSelection();
  renderMessages();
  $("prompt").focus();
}
function newSession() {
  if (!workspace || sessionBusy()) return;
  saveSessions();
  makeSession();
  renderMessages();
  $("prompt").focus();
}
function renderSidebar() {
  $("sidebar").hidden = sidebarCollapsed;
  $("expand-sidebar").hidden = !sidebarCollapsed;
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  $("files-panel").hidden = sidebarView !== "files";
  $("sessions-panel").hidden = sidebarView !== "sessions";
  const toggle = $("sidebar-view"), files = sidebarView === "files";
  toggle.title = files ? "Show sessions" : "Show files";
  toggle.setAttribute("aria-label", toggle.title);
  toggle.replaceChildren(icon(files ? "chat" : "folder"));
  documentViewer?.resize();
}
function saveSidebar() {
  try { localStorage.setItem("arma-sidebar", JSON.stringify({ view: sidebarView, collapsed: sidebarCollapsed })); } catch {}
  renderSidebar();
}
function conversation() {
  if (!conversations.has(provider))
    conversations.set(provider, {
      id: crypto.randomUUID(),
      messages: [],
      draft: "",
      runId: null,
      starting: false,
      pending: [],
      activity: "",
      redact: false,
      database: false,
      summaries: false,
      unredact: false,
      source: null,
    });
  return conversations.get(provider);
}
const providerName = () =>
  providers.find((item) => item.id === provider)?.name || "Claude Code";
function notify(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(
    () => {
      $("toast").hidden = true;
    },
    error ? 9000 : 5000,
  );
}
function controls() {
  const thread = conversation(),
    running = !!thread.runId || thread.starting;
  $("prompt").disabled = !workspace || running;
  $("prompt").placeholder = workspace
    ? thread.unredact ? unredactionPlaceholder : thread.summaries ? patientSummaryPlaceholder : thread.database ? databasePlaceholder : thread.redact
      ? redactionPlaceholder
      : `Message ${providerName()}…`
    : "Open a workspace to begin";
  $("send").disabled =
    !workspace ||
    running ||
    fileBusy ||
    !$("prompt").value.trim() ||
    providerLoading ||
    !providers.find((item) => item.id === provider)?.available;
  if ((thread.redact || thread.database || thread.summaries || thread.unredact) && !thread.source) $("send").disabled = true;
  $("redact-skill").disabled = !workspace || running || fileBusy;
  $("redact-skill").setAttribute("aria-pressed", String(thread.redact));
  $("database-skill").disabled = !workspace || running || fileBusy;
  $("database-skill").setAttribute("aria-pressed", String(thread.database));
  $("patient-summaries-skill").disabled = !workspace || running || fileBusy;
  $("patient-summaries-skill").setAttribute("aria-pressed", String(thread.summaries));
  $("unredact-skill").disabled = !workspace || running || fileBusy;
  $("unredact-skill").setAttribute("aria-pressed", String(!!thread.unredact));
  $("unredact-mappings").hidden = !thread.unredact;
  $("unredact-mappings").disabled = !workspace || running || fileBusy || !thread.source;
  $("unredact-mappings").title = thread.source?.mappingCount ? `${thread.source.mappingCount} mapping CSV${thread.source.mappingCount === 1 ? "" : "s"} selected — change mappings` : "Choose mapping CSVs";
  if (thread.unredact && !thread.source?.mappingCount) $("send").disabled = true;
  $("redact-choose").textContent = thread.unredact ? "Choose summaries" : "Choose file";
  $("source-suggestions").setAttribute("aria-label", thread.unredact ? "Patient summary folders" : thread.summaries ? "Patient databases" : thread.database ? "Reports and databases" : "Files to redact");
  $("redact-choose").hidden = !thread.redact && !thread.database && !thread.summaries && !thread.unredact;
  $("redact-choose").disabled = !workspace || running || fileBusy;
  for (const button of document.querySelectorAll("[data-approve-redaction]"))
    button.disabled = running || fileBusy;
  $("edit-prompt").disabled = $("prompt").disabled;
  $("send").hidden = running;
  $("stop").hidden = !running;
  $("stop").disabled = thread.starting;
  $("model").disabled = running || providerLoading;
  $("effort").disabled = running || providerLoading || !selectedModel()?.efforts.length;
  $("new-conversation").disabled = $("new-session").disabled = !workspace || running || fileBusy;
  for (const button of document.querySelectorAll(".session-row")) button.disabled = running || fileBusy;
  for (const id of ["add-files", "refresh-files", "reveal-workspace"])
    $(id).disabled = !workspace || fileBusy;
  $("add-files").disabled = !workspace || fileBusy || running;
  for (const id of [
    "open-workspace",
    "create-workspace",
    "welcome-open",
    "welcome-create",
  ])
    $(id).disabled = fileBusy || running;
  $("activity").textContent = thread.activity;
  $("activity").classList.toggle("busy", running);
}
function renderMessages() {
  const thread = conversation();
  $("messages").replaceChildren();
  for (const message of thread.messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    const author = document.createElement("div");
    author.className = "message-author";
    author.append(
      icon(message.role === "user" ? "user" : "spark"),
      document.createTextNode(
        message.role === "user"
          ? "You"
          : message.role === "stopped" ? "Stopped"
          : message.role === "error"
            ? "Connection error"
            : providerName(),
      ),
    );
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.text || "…";
    const actions = document.createElement("button");
    actions.type = "button";
    actions.className = "icon-button message-actions";
    actions.title = "Text actions";
    actions.setAttribute("aria-label", "Text actions");
    actions.setAttribute("aria-haspopup", "menu");
    actions.append(icon("more"));
    actions.addEventListener("mousedown", event => event.preventDefault());
    actions.onclick = () => {
      const selection = window.getSelection();
      if (!selection.toString() || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) {
        const range = document.createRange();
        range.selectNodeContents(body);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      window.arma.editMenu({ editable: false, selection: !!selection.toString() }).catch(error => notify(error.message, true));
    };
    author.append(actions);
    article.append(author, body);
    $("messages").append(article);
    message.element = body;
  }
  $("welcome").hidden = !!workspace;
  $("chat-empty").hidden = !workspace || thread.messages.length > 0;
  $("conversation-name").textContent =
    activeSession()?.title || "New session";
  $("prompt").value = thread.draft;
  renderRedactionSource();
  closeSourceSuggestions();
  $("messages").scrollTop = $("messages").scrollHeight;
  $("prompt").style.height = "auto";
  $("prompt").style.height = `${Math.min($("prompt").scrollHeight, 190)}px`;
  renderSessions();
  controls();
  saveSessions();
}
async function chooseWorkspace(method, arg) {
  fileBusy = true;
  controls();
  try {
    await saveSessions();
    const result = await window.arma[method](arg);
    if (!result) return;
    workspace = result;
    restoreSessions(result.sessions);
    redactionJobs = [];
    renderRedactionResults();
    closeSourceSuggestions();
    selectedFolder = "unredacted";
    selectedFile = null;
    expanded = new Set(["", "unredacted", "redacted"]);
    $("preview").hidden = true;
    disposeDocumentViewer();
    previewPath = null;
    previewVersion++;
    $("workspace-name").textContent = result.name;
    $("workspace-path").textContent = result.path;
    $("workspace-path").title = result.path;
    $("recents").hidden = true;
    $("file-status").textContent = "";
    renderMessages();
    await refreshTree();
    await refreshRedactionJobs();
    $("prompt").focus();
  } catch (error) {
    notify(error.message, true);
  } finally {
    fileBusy = false;
    controls();
  }
}
function treeRow(entry, depth, isRoot = false) {
  const directory = entry.kind === "directory",
    open = expanded.has(entry.path);
  const movable = !!entry.path && !["unredacted", "redacted"].includes(entry.path) &&
    entry.path !== "unredacted/redaction-runs" && !entry.path.startsWith("unredacted/redaction-runs/");
  const row = document.createElement("div");
  row.tabIndex = 0;
  row.className = `tree-row${isRoot ? " root" : ""}`;
  row.dataset.path = entry.path;
  row.dataset.kind = entry.kind;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  row.setAttribute(
    "aria-selected",
    String(
      directory
        ? selectedFolder === entry.path && !selectedFile
        : selectedFile === entry.path,
    ),
  );
  row.classList.toggle(
    "selected",
    row.getAttribute("aria-selected") === "true",
  );
  if (directory) row.setAttribute("aria-expanded", String(open));
  row.style.paddingLeft = `${8 + depth * 15}px`;
  row.append(
    icon(
      directory ? (open ? "down" : "chevron") : "file",
      directory ? "chevron" : "file-icon",
    ),
  );
  if (directory)
    row.append(icon(open ? "folderOpen" : "folder", "folder-icon"));
  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = entry.name;
  row.append(name);
  row.title = entry.path || workspace.path;
  if (entry.path === "unredacted") {
    row.append(icon("lock", "protected-icon"));
    row.title = "unredacted · excluded from agent access";
  }
  const actions = document.createElement("button");
  actions.type = "button";
  actions.className = "icon-button file-actions";
  actions.title = "File actions";
  actions.setAttribute("aria-label", `Actions for ${entry.name}`);
  actions.setAttribute("aria-haspopup", "menu");
  actions.append(icon("more"));
  actions.addEventListener("click", event => {
    event.stopPropagation();
    showFileMenu(entry);
  });
  actions.addEventListener("dblclick", event => event.stopPropagation());
  row.append(actions);
  row.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    showFileMenu(entry);
  });
  row.addEventListener("click", () => {
    if (directory) {
      selectedFolder = entry.path;
      selectedFile = null;
      open ? expanded.delete(entry.path) : expanded.add(entry.path);
      refreshTree().catch((error) => notify(error.message, true));
    } else showPreview(entry.path);
  });
  row.addEventListener("dblclick", () => {
    if (directory)
      window.arma
        .reveal(entry.path)
        .catch((error) => notify(error.message, true));
  });
  row.addEventListener("keydown", (event) => {
    if (event.target !== row) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      showFileMenu(entry);
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      if (movable) fileAction("rename", entry);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      row.click();
      return;
    }
    if (
      directory &&
      (event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      event.key === "ArrowRight"
        ? expanded.add(entry.path)
        : expanded.delete(entry.path);
      refreshTree(entry.path).catch((error) => notify(error.message, true));
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = [...$("tree").querySelectorAll(".tree-row")];
      rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    }
  });
  row.draggable = movable;
  row.addEventListener("dragstart", event => {
    if (fileBusy || conversation().runId || conversation().starting || !row.draggable) {
      event.preventDefault();
      return;
    }
    draggedItem = { path: entry.path, workspace };
    event.dataTransfer.setData(internalDragType, entry.path);
    event.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    draggedItem = null;
    document.querySelectorAll(".drop-target").forEach(item => item.classList.remove("drop-target"));
  });
  if (directory) {
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = fileBusy || conversation().runId || conversation().starting
        ? "none" : draggedItem ? "move" : "copy";
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", (event) => {
      if (!row.contains(event.relatedTarget))
        row.classList.remove("drop-target");
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove("drop-target");
      if (draggedItem && draggedItem.workspace === workspace && event.dataTransfer.types.includes(internalDragType)) {
        const source = draggedItem.path;
        draggedItem = null;
        changeFiles(() => window.arma.move(source, entry.path));
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (!files.length)
        return notify("Drop files or folders from your file manager.", true);
      importFiles("dropFiles", entry.path, files);
    });
  }
  return row;
}

async function showFileMenu(entry) {
  const currentWorkspace = workspace;
  if (entry.kind === "directory") { selectedFolder = entry.path; selectedFile = null; }
  else selectedFile = entry.path;
  document.querySelectorAll(".tree-row").forEach(row => {
    const selected = row.dataset.path === (selectedFile ?? selectedFolder);
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
  });
  try {
    const action = await window.arma.fileMenu(entry.path);
    if (action && workspace === currentWorkspace) await fileAction(action, entry);
  } catch (error) { notify(error.message, true); }
}

function requestName(title, name, submitLabel) {
  $("file-dialog-title").textContent = title;
  $("file-name-input").value = name;
  $("file-name-submit").textContent = submitLabel;
  const dialog = $("file-dialog");
  dialog.returnValue = "";
  dialog.showModal();
  $("file-name-input").focus();
  const extension = name.lastIndexOf(".");
  $("file-name-input").setSelectionRange(0, extension > 0 ? extension : name.length);
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "save" ? $("file-name-input").value : null), { once: true });
  });
}

async function fileAction(action, entry) {
  if (action === "reveal") {
    try { await window.arma.reveal(entry.path); } catch (error) { notify(error.message, true); }
    return;
  }
  await changeFiles(async () => {
    if (action === "rename") {
      const name = await requestName("Rename item", entry.name, "Rename");
      return name === null ? null : window.arma.rename(entry.path, name);
    }
    if (action === "new-folder") {
      const name = await requestName("New folder", "", "Create");
      return name === null ? null : window.arma.createFolder(entry.path, name);
    }
    if (action === "move") {
      const destination = await window.arma.pickDestination(entry.path);
      return destination === null ? null : window.arma.move(entry.path, destination);
    }
  });
}

async function changeFiles(operation) {
  if (!workspace || fileBusy) return;
  if (conversation().runId || conversation().starting)
    return notify("Stop the agent turn before changing files.", true);
  fileBusy = true;
  controls();
  try {
    const result = await operation();
    if (!result?.changed) return;
    const remap = value => result.from && value !== null &&
      (value === result.from || value.startsWith(`${result.from}/`))
      ? result.path + value.slice(result.from.length) : value;
    expanded = new Set([...expanded].map(remap));
    selectedFolder = remap(selectedFolder);
    selectedFile = remap(selectedFile);
    previewPath = remap(previewPath);
    if (result.kind === "directory") selectedFolder = result.path;
    else selectedFile = result.path;
    const parents = result.path.split("/");
    for (let i = 0; i < parents.length; i++) expanded.add(parents.slice(0, i).join("/"));
    if (result.kind === "directory") expanded.add(result.path);
    // Backend source tokens are invalidated by filesystem edits. Keep drafts,
    // but require re-selection before a redaction/database turn can start.
    for (const session of workspaceSessions)
      for (const thread of session.conversations.values()) thread.source = null;
    renderRedactionSource();
    closeSourceSuggestions();
    $("file-status").textContent = result.from ? "Item updated" : "Folder created";
    previewVersion++;
    previewLoadingVersion = 0;
    disposeDocumentViewer();
    if (previewPath) {
      $("preview-name").textContent = previewPath.split("/").pop();
      await showPreview(previewPath, false);
    }
    await refreshTree(result.path);
    await refreshRedactionJobs();
  } catch (error) { notify(error.message, true); }
  finally {
    fileBusy = false;
    controls();
    await refreshWorkspaceView().catch(() => {});
  }
}
async function refreshTree(focusPath) {
  if (!workspace) return;
  const version = ++treeVersion,
    root = workspace;
  const fragment = document.createDocumentFragment();
  fragment.append(
    treeRow({ name: root.name, path: "", kind: "directory" }, 0, true),
  );
  async function appendChildren(relative, depth) {
    const entries = await window.arma.list(relative);
    if (version !== treeVersion) return;
    if (!entries.length && relative) {
      const empty = document.createElement("div");
      empty.className = "empty-folder";
      empty.textContent = "Empty folder";
      empty.style.paddingLeft = `${39 + depth * 15}px`;
      fragment.append(empty);
    }
    for (const entry of entries) {
      fragment.append(treeRow(entry, depth));
      if (entry.kind === "directory" && expanded.has(entry.path)) {
        try {
          await appendChildren(entry.path, depth + 1);
        } catch {
          expanded.delete(entry.path);
        }
      }
    }
  }
  if (expanded.has("")) await appendChildren("", 1);
  if (version !== treeVersion || workspace !== root) return;
  $("tree").replaceChildren(fragment);
  if (focusPath !== undefined)
    [...$("tree").querySelectorAll(".tree-row")]
      .find((row) => row.dataset.path === focusPath)
      ?.focus();
}
async function importFiles(method, destination, files) {
  if (!workspace || fileBusy) return;
  if (conversation().runId || conversation().starting)
    return notify("Stop the agent turn before adding files.", true);
  fileBusy = true;
  controls();
  $("file-status").textContent = "Adding files…";
  $("cancel-import").hidden = false;
  $("cancel-import").disabled = false;
  try {
    const result =
      method === "dropFiles"
        ? await window.arma.dropFiles(files, destination)
        : await window.arma.pickFiles(destination);
    if (!result) {
      $("file-status").textContent = "";
      return;
    }
    selectedFolder = destination;
    selectedFile = null;
    expanded.add("");
    const parts = destination.split("/");
    for (let i = 1; i <= parts.length; i++)
      expanded.add(parts.slice(0, i).join("/"));
    const count = result.copied.length;
    $("file-status").textContent =
      `${count} ${count === 1 ? "item" : "items"} added${result.cancelled ? " · Import cancelled" : ""}`;
    if (result.skipped.length)
      notify(
        result.skipped.map((item) => `${item.name}: ${item.reason}`).join("\n"),
        true,
      );
    else if (count && !result.cancelled)
      notify(
        `Added ${count} ${count === 1 ? "item" : "items"} to ${destination || workspace.name}.`,
      );
    await refreshTree();
  } catch (error) {
    $("file-status").textContent = "";
    notify(error.message, true);
  } finally {
    $("cancel-import").hidden = true;
    fileBusy = false;
    controls();
  }
}
async function showPreview(relative, select = true) {
  const version = ++previewVersion;
  previewLoadingVersion = version;
  if (select) {
    selectedFile = relative;
    previewPath = relative;
    disposeDocumentViewer();
    $("preview").hidden = false;
    $("preview-name").textContent = relative.split("/").pop();
    $("preview-meta").textContent = "Loading local preview…";
    const loading = document.createElement("p");
    loading.className = "viewer-message";
    loading.textContent = "Loading…";
    $("preview-content").replaceChildren(loading);
  }
  try {
    const file = await window.arma.preview(relative);
    if (version !== previewVersion) return;
    if (!select && file.revision === previewRevision) {
      await refreshTree();
      return;
    }
    disposeDocumentViewer();
    $("preview").hidden = false;
    previewPath = relative;
    $("preview-name").textContent = file.name;
    $("preview-name").title = relative;
    $("preview-content").replaceChildren();
    if (file.kind === "spreadsheet" || file.kind === "pdf") {
      $("preview-content").classList.add("document");
      const viewers = await import("./document-viewers.mjs");
      if (version !== previewVersion) return;
      const viewer = await (file.kind === "spreadsheet"
        ? viewers.spreadsheetViewer($("preview-content"), file)
        : viewers.pdfViewer(
            $("preview-content"),
            file,
            () => version === previewVersion,
          ));
      if (version !== previewVersion) {
        viewer.destroy();
        return;
      }
      documentViewer = viewer;
    } else if (file.kind === "text") {
      const pre = document.createElement("pre");
      pre.textContent = file.text;
      $("preview-content").append(pre);
    } else if (file.kind === "image") {
      const img = document.createElement("img");
      img.src = file.dataUrl;
      img.alt = file.name;
      $("preview-content").append(img);
    } else {
      const p = document.createElement("p");
      p.className = "unsupported";
      p.textContent =
        "Preview is not available for this file. Use Reveal file to open it from your file manager.";
      $("preview-content").append(p);
    }
    $("preview-meta").textContent =
      `${new Intl.NumberFormat().format(file.size)} bytes${file.truncated ? " · Preview truncated" : ""} · ${file.kind === "spreadsheet" ? "Saved workbook values · " : ""}Local preview`;
    previewRevision = file.revision;
    await refreshTree();
  } catch (error) {
    if (version === previewVersion) {
      $("preview").hidden = true;
      disposeDocumentViewer();
      previewPath = null;
      notify(error.message, true);
    }
  } finally {
    if (previewLoadingVersion === version) {
      previewLoadingVersion = 0;
      if (pendingPreviewRefresh) {
        pendingPreviewRefresh = false;
        refreshWorkspaceView().catch(() => {});
      }
    }
  }
}
async function refreshWorkspaceView() {
  if (fileBusy) return;
  if (previewPath && !previewLoadingVersion) await showPreview(previewPath, false);
  else {
    // A file watcher must not invalidate an in-flight local render. Check for
    // changes once it finishes instead of leaving a cancelled preview empty.
    if (previewPath) pendingPreviewRefresh = true;
    await refreshTree();
  }
  await refreshRedactionJobs();
}

function closeSourceSuggestions() {
  mentionVersion++;
  sourceOptions = [];
  $("source-suggestions").hidden = true;
  $("prompt").removeAttribute("aria-activedescendant");
  $("prompt").setAttribute("aria-expanded", "false");
}
function renderRedactionSource() {
  const thread = conversation(),
    container = $("redaction-source");
  container.replaceChildren();
  container.hidden = !(thread.redact || thread.database || thread.summaries || thread.unredact) || !thread.source;
  if (container.hidden) return;
  const name = document.createElement("span");
  name.textContent = thread.source.name + (thread.unredact ? ` · ${thread.source.mappingCount || 0} mapping${thread.source.mappingCount === 1 ? "" : "s"}` : "");
  name.title = thread.source.path;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Remove selected source");
  remove.disabled = !!thread.runId || thread.starting;
  remove.onclick = () => {
    thread.source = null;
    renderRedactionSource();
    controls();
  };
  container.append(icon("file"), name, remove);
}
async function selectSource(source) {
  const thread = conversation(),
    root = workspace;
  try {
    const database = thread.database || thread.summaries || thread.unredact;
    const selected = await window.arma[thread.unredact ? "selectUnredactionSource" : thread.summaries ? "selectPatientSummarySource" : database ? "selectDatabaseSource" : "selectRedactionSource"](source.path);
    if (root !== workspace || thread !== conversation()) return;
    thread.redact = !database;
    thread.source = selected;
    const prompt = $("prompt"),
      before = prompt.value.slice(0, prompt.selectionStart),
      match = before.match(/@([^\n@]*)$/);
    if (match)
      prompt.value =
        prompt.value.slice(0, match.index) +
        prompt.value.slice(prompt.selectionStart);
    thread.draft = prompt.value;
    saveSessions();
    closeSourceSuggestions();
    renderRedactionSource();
    controls();
    prompt.focus();
  } catch (error) {
    notify(error.message, true);
  }
}
async function updateSourceSuggestions() {
  const prompt = $("prompt"),
    match = prompt.value.slice(0, prompt.selectionStart).match(/@([^\n@]*)$/);
  if (!match || !workspace) {
    closeSourceSuggestions();
    return;
  }
  const version = ++mentionVersion,
    root = workspace;
  try {
    const database = conversation().database || conversation().summaries || conversation().unredact;
    const sources = await window.arma[conversation().unredact ? "unredactionSources" : conversation().summaries ? "patientSummarySources" : database ? "databaseSources" : "redactionSources"]();
    if (version !== mentionVersion || root !== workspace) return;
    const query = match[1].toLowerCase();
    sourceOptions = sources
      .filter((item) => item.path.toLowerCase().includes(query))
      .slice(0, 12);
    sourceOptionIndex = 0;
    const container = $("source-suggestions");
    container.replaceChildren();
    container.hidden = false;
    if (!sourceOptions.length) {
      const empty = document.createElement("div");
      empty.textContent = `No matching source files in ${database ? "redacted" : "unredacted"}`;
      container.append(empty);
    }
    sourceOptions.forEach((source, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `source-option-${index}`;
      button.setAttribute("role", "option");
      button.textContent = source.path;
      button.onmousedown = (event) => event.preventDefault();
      button.onclick = () => selectSource(source);
      container.append(button);
    });
    prompt.setAttribute("aria-controls", "source-suggestions");
    prompt.setAttribute("aria-expanded", "true");
    highlightSourceOption();
  } catch (error) {
    closeSourceSuggestions();
    notify(error.message, true);
  }
}
function highlightSourceOption() {
  [...$("source-suggestions").querySelectorAll("[role=option]")].forEach(
    (item, index) =>
      item.setAttribute("aria-selected", String(index === sourceOptionIndex)),
  );
  if (sourceOptions.length)
    $("prompt").setAttribute(
      "aria-activedescendant",
      `source-option-${sourceOptionIndex}`,
    );
}
async function refreshRedactionJobs() {
  if (!workspace) return;
  const version = ++jobsVersion,
    root = workspace;
  const jobs = await window.arma.redactionJobs();
  if (version !== jobsVersion || root !== workspace) return;
  redactionJobs = jobs;
  renderRedactionResults();
}
function renderRedactionResults() {
  const container = $("redaction-results");
  container.replaceChildren();
  container.hidden = !redactionJobs.length;
  for (const job of redactionJobs.slice(0, 8)) {
    const card = document.createElement("div");
    card.className = "redaction-result";
    card.dataset.job = job.id;
    const label = document.createElement("div");
    label.className = "redaction-result-label";
    label.textContent = `${job.items} items redacted from ${job.name}${job.status === "published" ? " · In Redacted" : ""}`;
    card.append(label);
    const actions = document.createElement("div");
    actions.className = "redaction-result-actions";
    const action = (label, fn) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.onclick = () =>
        Promise.resolve(fn()).catch((error) => notify(error.message, true));
      actions.append(button);
      return button;
    };
    action(
      job.status === "published" ? "View copy" : "Review copy",
      async () => {
        await showPreview(
          job.status === "published" ? job.output : job.preview,
        );
      },
    );
    action("Mapping CSV", () => showPreview(job.mapping));
    action("Script", () => showPreview(job.script));
    if (job.status !== "published" && job.items) {
      const approve = action("Move to Redacted", async () => {
        await window.arma.approveRedaction(job.id);
        await refreshWorkspaceView();
        notify("Document added to Redacted. The mapping stays private.");
      });
      approve.dataset.approveRedaction = job.id;
      approve.title = "Move the completed document to Redacted for agent access";
    }
    card.append(actions);
    container.append(card);
  }
  controls();
}
const effortNames = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
function providerModels(item) {
  return item?.models?.length ? item.models : [{ id: "", name: `${item?.id === "codex" ? "Codex" : "Claude"} default`, efforts: [], defaultEffort: "" }];
}
function selectedModel() {
  return providerModels(providers.find((item) => item.id === provider)).find((item) => item.id === model);
}
function restoreModelSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem("arma-model-selection"));
    if (saved && [saved.provider, saved.model, saved.effort].every((value) => typeof value === "string")) {
      provider = saved.provider;
      model = saved.model;
      effort = saved.effort;
    }
  } catch { /* Storage can be unavailable. Provider defaults still work. */ }
}
function saveModelSelection() {
  try { localStorage.setItem("arma-model-selection", JSON.stringify({ provider, model, effort })); } catch {}
}
function renderModelOptions() {
  $("model").replaceChildren();
  if (!providers.some((item) => item.id === provider)) {
    provider = providers[0]?.id || "claude";
    model = "";
    effort = "";
  }
  for (const item of providers) {
    const group = document.createElement("optgroup");
    group.label = item.name;
    for (const choice of providerModels(item)) {
      const option = document.createElement("option");
      option.value = `${item.id}:${choice.id}`;
      option.dataset.provider = item.id;
      option.dataset.model = choice.id;
      option.textContent = choice.name;
      group.append(option);
    }
    $("model").append(group);
  }
  if (!selectedModel()) {
    const choices = providerModels(providers.find((item) => item.id === provider));
    const choice = choices.find((item) => item.isDefault) || choices[0];
    model = choice.id;
    effort = choice.defaultEffort || "";
  }
  $("model").value = `${provider}:${model}`;
  renderEfforts();
}
function renderEfforts() {
  const choice = selectedModel();
  $("effort").replaceChildren();
  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = choice?.efforts.length ? "Default" : "Automatic";
  $("effort").append(automatic);
  for (const value of choice?.efforts || []) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = effortNames[value] || value;
    $("effort").append(option);
  }
  if (effort && !choice?.efforts.includes(effort)) effort = choice?.defaultEffort || "";
  $("effort").value = effort;
}
async function loadProviders() {
  providerLoading = true;
  controls();
  try {
    providers = await window.arma.providers();
    renderModelOptions();
    renderConnections();
    providerIndicator();
  } catch (error) {
    notify(error.message, true);
  } finally {
    providerLoading = false;
    controls();
  }
}
function providerIndicator() {
  const active = providers.find((item) => item.id === provider);
  $("provider-state").classList.toggle("available", !!active?.available &&
    (provider !== "claude" || active.auth?.phase === "signed-in"));
  $("provider-state").title = active?.available
    ? (provider === "claude" ? `Claude: ${claudeAuthLabel(active.auth)}` : `${active.name} CLI available`)
    : active?.error || "CLI unavailable";
}
function claudeAuthLabel(auth) {
  return ({ "signed-in": "Signed in", "signed-out": "Not signed in", starting: "Opening sign-in…",
    waiting: "Finish sign-in in your browser", checking: "Checking sign-in…", error: "Sign-in needs attention",
    unavailable: "Unavailable", unknown: "Checking sign-in…" })[auth?.phase || "unknown"];
}
function authChanged(auth) {
  const item = providers.find(item => item.id === "claude");
  if (item) item.auth = auth;
  renderConnections();
  providerIndicator();
}
window.arma.onAuthChanged(authChanged);
async function authAction(action) {
  try { const state = await action(); if (state) authChanged(state); }
  catch (error) { notify(error.message, true); }
}
function renderConnections() {
  $("connection-list").replaceChildren();
  for (const item of providers) {
    const row = document.createElement("div");
    row.className = "connection";
    row.dataset.provider = item.id;
    const heading = document.createElement("div");
    heading.className = "connection-title";
    const name = document.createElement("span");
    name.textContent = item.name;
    const status = document.createElement("span");
    status.className = "connection-state";
    status.setAttribute("role", "status");
    status.textContent = item.available ? (item.id === "claude" ? claudeAuthLabel(item.auth) : "CLI installed") : "Unavailable";
    heading.append(name, status);
    row.append(heading);
    if (item.id === "claude") {
      const auth = item.auth || {}, pending = ["starting", "waiting", "checking"].includes(auth.phase);
      const actions = document.createElement("div");
      actions.className = "connection-actions";
      const button = (id, label, glyph, action) => {
        const node = document.createElement("button");
        node.id = id;
        node.className = "secondary";
        node.append(icon(glyph), document.createTextNode(label));
        node.onclick = () => authAction(action);
        actions.append(node);
        return node;
      };
      if (pending) {
        if (auth.canOpenBrowser) button("claude-open-browser", "Open browser again", "external", window.arma.openClaudeSignIn);
        button("claude-cancel-sign-in", "Cancel", "close", window.arma.cancelClaudeSignIn);
      } else {
        const label = auth.phase === "signed-in" ? "Sign in again" : "Sign in to Claude";
        button("claude-sign-in", label, "external", window.arma.signInClaude).disabled = !item.available;
      }
      row.append(actions);
      if (auth.phase === "waiting" && auth.canOpenBrowser) {
        const details = document.createElement("details");
        details.className = "connection-code";
        const summary = document.createElement("summary");
        summary.textContent = "Use a sign-in code";
        const form = document.createElement("form");
        const input = document.createElement("input");
        input.id = "claude-sign-in-code";
        input.type = "password";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.maxLength = 4096;
        input.placeholder = "Paste the code from your browser";
        input.setAttribute("aria-label", "Claude sign-in code");
        const submit = document.createElement("button");
        submit.className = "secondary";
        submit.type = "submit";
        submit.textContent = "Continue";
        form.onsubmit = event => {
          event.preventDefault();
          const code = input.value;
          input.value = "";
          authAction(() => window.arma.submitClaudeCode(code));
        };
        form.append(input, submit);
        details.append(summary, form);
        row.append(details);
      }
      if (auth.message) {
        const message = document.createElement("p");
        message.className = "connection-error";
        message.setAttribute("role", "alert");
        message.textContent = auth.message;
        row.append(message);
      }
    } else {
      const code = document.createElement("code");
      code.textContent = "npx --no-install codex -c 'cli_auth_credentials_store=\"file\"' login";
      row.append(code);
    }
    if (item.error || item.modelError) {
      const p = document.createElement("p");
      p.className = "connection-error";
      p.textContent = item.error || item.modelError;
      row.append(p);
    }
    $("connection-list").append(row);
  }
}
function agentEvent(event) {
  const thread = [...conversations.values()].find(
    (item) => item.runId === event.runId,
  );
  if (!thread) {
    const starting = [...conversations.values()].find((item) => item.starting);
    if (starting) starting.pending.push(event);
    return;
  }
  const active = thread === conversation();
  if (event.type === "delta") {
    const message = thread.messages[thread.messages.length - 1];
    message.text += event.text || "";
    if (active && message.element) {
      const nearBottom =
        $("messages").scrollHeight -
          $("messages").scrollTop -
          $("messages").clientHeight <
        100;
      message.element.textContent = message.text;
      if (nearBottom) $("messages").scrollTop = $("messages").scrollHeight;
    }
  } else if (event.type === "status")
    thread.activity = event.text || event.message || "Working…";
  else if (event.type === "error") {
    const pending = thread.messages[thread.messages.length - 1];
    if (pending?.role === "assistant" && !pending.text) thread.messages.pop();
    thread.messages.push({
      role: "error",
      text:
        event.text ||
        event.message ||
        "The agent could not complete this turn.",
    });
    thread.activity = "";
  } else if (event.type === "done") {
    thread.runId = null;
    thread.activity = event.cancelled ? "Stopped" : "";
    const last = thread.messages[thread.messages.length - 1];
    if (last?.role === "assistant" && !last.text) {
      if (event.cancelled) {
        last.role = "stopped";
        last.text = "Stopped.";
      } else thread.messages.pop();
    }
    refreshWorkspaceView().catch(() => {});
  }
  if (active) {
    if (event.type === "error" || event.type === "done") renderMessages();
    else controls();
  }
}
async function submit(event) {
  event.preventDefault();
  const thread = conversation(),
    prompt = $("prompt").value.trim();
  if (!workspace || !prompt || fileBusy || thread.runId || thread.starting)
    return;
  if ((thread.redact || thread.database || thread.summaries || thread.unredact) && !thread.source) {
    notify("Choose a source file, or select one with @.", true);
    return;
  }
  if (thread.unredact && !thread.source.mappingCount) { notify("Choose the matching mapping CSVs.", true); return; }
  thread.draft = "";
  thread.starting = true;
  thread.activity = "Connecting…";
  const session = activeSession();
  if (session && !session.title) session.title = prompt.replace(/\s+/g, " ").slice(0, 120);
  thread.messages.push(
    {
      role: "user",
      text: thread.unredact ? `Unredact Summaries: ${thread.source.name}\n${prompt}` : thread.summaries ? `Patient Summaries: ${thread.source.name}\n${prompt}` : thread.database ? `Database: ${thread.source.name}\n${prompt}` : thread.redact ? `Redact ${thread.source.name}\n${prompt}` : prompt,
    },
    { role: "assistant", text: "" },
  );
  renderMessages();
  try {
    const { runId } = await window.arma.start({
      provider,
      model,
      effort,
      prompt,
      conversationId: thread.id,
      ...(thread.redact ? { skill: "redact", sourceId: thread.source.id } : {}),
      ...(thread.database ? { skill: "database", sourceId: thread.source.id } : {}),
      ...(thread.summaries ? { skill: "patient-summaries", sourceId: thread.source.id } : {}),
      ...(thread.unredact ? { skill: "unredact-summaries", sourceId: thread.source.id } : {}),
    });
    thread.runId = runId;
    thread.starting = false;
    const pending = thread.pending.splice(0);
    pending.forEach(agentEvent);
  } catch (error) {
    thread.messages.pop();
    thread.messages.push({ role: "error", text: error.message });
    thread.draft = prompt;
    thread.activity = "";
    thread.pending = [];
  } finally {
    thread.starting = false;
    controls();
    if (!thread.runId) renderMessages();
  }
}
$("open-workspace").onclick = $("welcome-open").onclick = () =>
  chooseWorkspace("openWorkspace");
$("create-workspace").onclick = $("welcome-create").onclick = () =>
  chooseWorkspace("createWorkspace");
$("add-files").onclick = () => importFiles("pickFiles", selectedFolder);
$("redact-skill").onclick = () => {
  const thread = conversation();
  thread.redact = !thread.redact;
  thread.source = null;
  thread.database = false;
  thread.summaries = false;
  thread.unredact = false;
  saveSessions();
  renderRedactionSource();
  closeSourceSuggestions();
  controls();
  $("prompt").focus();
};
$("database-skill").onclick = () => {
  const thread = conversation();
  thread.database = !thread.database;
  thread.summaries = false;
  thread.unredact = false;
  thread.source = null;
  thread.redact = false;
  saveSessions();
  renderRedactionSource();
  closeSourceSuggestions();
  controls();
  $("prompt").focus();
};
$("patient-summaries-skill").onclick = () => {
  const thread = conversation();
  thread.summaries = !thread.summaries;
  thread.unredact = false;
  thread.source = null;
  thread.redact = false;
  thread.database = false;
  if (thread.summaries && !$("prompt").value.trim()) {
    $("prompt").value = patientSummaryPlaceholder;
    thread.draft = patientSummaryPlaceholder;
  }
  saveSessions();
  renderRedactionSource();
  closeSourceSuggestions();
  controls();
  $("prompt").focus();
};
$("unredact-skill").onclick = () => {
  const thread = conversation();
  thread.unredact = !thread.unredact;
  thread.redact = false;
  thread.database = false;
  thread.summaries = false;
  thread.source = null;
  if (thread.unredact && !$("prompt").value.trim()) {
    $("prompt").value = unredactionPlaceholder;
    thread.draft = unredactionPlaceholder;
  }
  renderRedactionSource();
  closeSourceSuggestions();
  controls();
  saveSessions();
  $("prompt").focus();
};
$("unredact-mappings").onclick = async () => {
  const thread = conversation(), root = workspace;
  if (!thread.source) return;
  fileBusy = true; controls();
  try {
    const selected = await window.arma.pickUnredactionMappings(thread.source.id);
    if (selected && root === workspace && thread === conversation()) {
      thread.source = selected; renderRedactionSource();
    }
  } catch (error) { notify(error.message, true); }
  finally { fileBusy = false; controls(); }
};
$("redact-choose").onclick = async () => {
  const thread = conversation(),
    root = workspace;
  fileBusy = true;
  controls();
  try {
    const database = thread.database || thread.summaries || thread.unredact;
    const source = await window.arma[thread.unredact ? "pickUnredactionSource" : thread.summaries ? "pickPatientSummarySource" : database ? "pickDatabaseSource" : "pickRedactionSource"]();
    if (source && root === workspace && thread === conversation()) {
      thread.redact = !database;
      thread.source = source;
      renderRedactionSource();
      await refreshTree();
    }
  } catch (error) {
    notify(error.message, true);
  } finally {
    fileBusy = false;
    controls();
    $("prompt").focus();
  }
};
$("cancel-import").onclick = async () => {
  $("cancel-import").disabled = true;
  try {
    await window.arma.cancelImport();
  } catch (error) {
    notify(error.message, true);
  }
};
$("refresh-files").onclick = () =>
  refreshTree().catch((error) => notify(error.message, true));
$("reveal-workspace").onclick = () =>
  window.arma.reveal("").catch((error) => notify(error.message, true));
$("reveal-file").onclick = () =>
  window.arma.reveal(previewPath).catch((error) => notify(error.message, true));
$("close-preview").onclick = () => {
  disposeDocumentViewer();
  window.arma.cancelPreview().catch(() => {});
  $("preview").hidden = true;
  selectedFile = null;
  previewPath = null;
  previewVersion++;
  refreshTree().catch(() => {});
};
$("expand-preview").onclick = () => {
  const expanded = $("preview").classList.toggle("expanded");
  $("expand-preview").title = expanded
    ? "Restore preview size"
    : "Expand preview";
  $("expand-preview").setAttribute("aria-label", $("expand-preview").title);
  documentViewer?.resize();
};
window.addEventListener("resize", () => documentViewer?.resize());
$("connections").onclick = () => {
  renderConnections();
  $("connections-dialog").showModal();
  loadProviders();
};
$("close-connections").onclick = () => $("connections-dialog").close();
$("refresh-connections").onclick = loadProviders;
$("new-conversation").onclick = $("new-session").onclick = newSession;
$("sidebar-view").onclick = () => {
  sidebarView = sidebarView === "files" ? "sessions" : "files";
  saveSidebar();
};
$("collapse-sidebar").onclick = () => {
  sidebarCollapsed = true;
  saveSidebar();
  $("expand-sidebar").focus();
};
$("expand-sidebar").onclick = () => {
  sidebarCollapsed = false;
  saveSidebar();
  $("collapse-sidebar").focus();
};
$("model").onchange = () => {
  const previous = conversation();
  previous.draft = $("prompt").value;
  const option = $("model").selectedOptions[0];
  const switchingProvider = provider !== option.dataset.provider;
  provider = option.dataset.provider;
  if (switchingProvider) {
    // The model selector changes the provider, not the operator's selected workflow.
    // Keep histories separate while carrying the bound file and unfinished request.
    const next = conversation();
    next.redact = previous.redact;
    next.database = previous.database;
    next.summaries = previous.summaries;
    next.unredact = previous.unredact;
    next.source = previous.source;
    if (previous.redact || previous.database || previous.summaries || previous.unredact) next.draft = previous.draft;
  }
  model = option.dataset.model;
  effort = selectedModel()?.defaultEffort || "";
  renderEfforts();
  saveModelSelection();
  providerIndicator();
  renderMessages();
};
$("effort").onchange = () => {
  effort = $("effort").value;
  saveModelSelection();
  saveSessions();
};
$("prompt").oninput = () => {
  conversation().draft = $("prompt").value;
  saveSessions();
  controls();
  $("prompt").style.height = "auto";
  $("prompt").style.height = `${Math.min($("prompt").scrollHeight, 190)}px`;
  updateSourceSuggestions();
};
$("prompt").onkeydown = (event) => {
  if (!$("source-suggestions").hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSourceSuggestions();
      return;
    }
    if (
      sourceOptions.length &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        sourceOptionIndex =
          (sourceOptionIndex +
            (event.key === "ArrowDown" ? 1 : sourceOptions.length - 1)) %
          sourceOptions.length;
        highlightSourceOption();
      } else selectSource(sourceOptions[sourceOptionIndex]);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$("send").disabled) $("composer").requestSubmit();
  }
};
$("composer").onsubmit = submit;
$("edit-prompt").addEventListener("mousedown", event => event.preventDefault());
$("edit-prompt").onclick = () => {
  $("prompt").focus();
  window.arma.editMenu({ editable: !$("prompt").disabled, selection: $("prompt").selectionStart !== $("prompt").selectionEnd })
    .catch(error => notify(error.message, true));
};
$("file-name-cancel").onclick = () => $("file-dialog").close();
$("stop").onclick = async () => {
  try {
    $("stop").disabled = true;
    conversation().activity = "Stopping…";
    await window.arma.cancel(conversation().runId);
  } catch (error) {
    notify(error.message, true);
  } finally {
    controls();
  }
};
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "none";
});
document.addEventListener("drop", (event) => event.preventDefault());
window.arma.onAgentEvent(agentEvent);
window.arma.onSessionError(message => notify(message, true));
window.arma.onFilesChanged((event) => {
  if (event.path === workspace?.path) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      () => refreshWorkspaceView().catch(() => {}),
      120,
    );
  }
});
window.addEventListener("focus", () => {
  if (workspace) refreshWorkspaceView().catch(() => {});
});
async function init() {
  try {
    const state = await window.arma.state();
    providers = state.providers;
    redactionPlaceholder = state.redactionPlaceholder || redactionPlaceholder;
    databasePlaceholder = state.databasePlaceholder || databasePlaceholder;
    patientSummaryPlaceholder = state.patientSummaryPlaceholder || patientSummaryPlaceholder;
    unredactionPlaceholder = state.unredactionPlaceholder || unredactionPlaceholder;
    if (state.platform !== "darwin") document.body.classList.add("windows");
    try {
      const saved = JSON.parse(localStorage.getItem("arma-sidebar"));
      sidebarView = saved?.view === "sessions" ? "sessions" : "files";
      sidebarCollapsed = saved?.collapsed === true;
    } catch {}
    renderSidebar();
    if (state.recent.length) {
      $("recents").hidden = false;
      for (const item of state.recent) {
        const button = document.createElement("button");
        button.className = "recent-button";
        button.title = item.path;
        button.append(icon("folder"), document.createTextNode(item.name));
        button.onclick = () => chooseWorkspace("recentWorkspace", item.path);
        $("recent-list").append(button);
      }
    }
    restoreModelSelection();
    renderModelOptions();
    renderConnections();
    providerIndicator();
    providerLoading = false;
    renderMessages();
    if (providers.length === 1 && providers[0].available && providers[0].auth?.phase === "signed-out")
      $("connections-dialog").showModal();
  } catch (error) {
    notify(error.message, true);
  }
}
init();
