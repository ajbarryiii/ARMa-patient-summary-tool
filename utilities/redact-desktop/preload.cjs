const { contextBridge, ipcRenderer, webUtils } = require("electron");
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function listen(channel, listener) {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
contextBridge.exposeInMainWorld("arma", {
  state: () => call("app:state"),
  openWorkspace: () => call("workspace:open"),
  createWorkspace: () => call("workspace:create"),
  recentWorkspace: (path) => call("workspace:recent", path),
  saveSessions: (root, view) => call("sessions:save", root, view),
  onSessionError: (listener) => listen("sessions:error", listener),
  list: (path) => call("files:list", path),
  fileMenu: (path) => call("files:menu", path),
  rename: (path, name) => call("files:rename", path, name),
  move: (path, destination) => call("files:move", path, destination),
  createFolder: (destination, name) => call("files:create-folder", destination, name),
  pickDestination: (path) => call("files:destination", path),
  editMenu: (options) => call("edit:menu", options),
  preview: (path, sheetIndex) => call("files:preview", path, sheetIndex),
  cancelPreview: () => call("files:cancel-preview"),
  redactionSources: () => call("redactions:sources"),
  selectRedactionSource: (path) => call("redactions:select", path),
  pickRedactionSource: () => call("redactions:pick"),
  databaseSources: () => call("databases:sources"),
  selectDatabaseSource: (path) => call("databases:select", path),
  pickDatabaseSource: () => call("databases:pick"),
  patientSummarySources: () => call("summaries:sources"),
  selectPatientSummarySource: (path) => call("summaries:select", path),
  pickPatientSummarySource: () => call("summaries:pick"),
  unredactionSources: () => call("unredactions:sources"),
  selectUnredactionSource: (path) => call("unredactions:select", path),
  pickUnredactionSource: () => call("unredactions:pick"),
  pickUnredactionMappings: (id) => call("unredactions:mappings", id),
  redactionJobs: () => call("redactions:jobs"),
  approveRedaction: (id) => call("redactions:approve", id),
  reveal: (path) => call("files:reveal", path),
  pickFiles: (destination) => call("files:pick", destination),
  cancelImport: () => call("files:cancel"),
  dropFiles: (files, destination) =>
    call(
      "files:drop",
      Array.from(files, (file) => webUtils.getPathForFile(file)).filter(
        Boolean,
      ),
      destination,
    ),
  providers: () => call("agents:status"),
  signInClaude: () => call("auth:start"),
  cancelClaudeSignIn: () => call("auth:cancel"),
  openClaudeSignIn: () => call("auth:browser"),
  submitClaudeCode: (code) => call("auth:code", code),
  onAuthChanged: (listener) => listen("auth:changed", listener),
  start: (args) => call("agents:start", args),
  cancel: (id) => call("agents:cancel", id),
  onFilesChanged: (listener) => listen("workspace:changed", listener),
  onAgentEvent: (listener) => listen("agents:event", listener),
});
