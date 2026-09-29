"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { Workspace } = require("./workspace.cjs");
const { WorkspaceError, WorkspaceTools } = require("./workspace-tools.cjs");
const { TOOL, validatePlan } = require("./unredaction-tools.cjs");
const { HEADERS } = require("./mapping-format.cjs");
const SOURCE_FOLDER = "redacted/Patient Summaries";
const OUTPUT_FOLDER = "unredacted/Patient Summaries";
const revision = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

class UnredactionService {
  constructor(workspace, changed = () => {}) {
    this.workspace = workspace;
    this.publicFiles = new WorkspaceTools(workspace.root);
    this.changed = changed;
    this.selections = new Map();
    this.pending = new Set();
  }
  async snapshot(relative, limit = 40 * 1024 * 1024) {
    const absolute = await this.workspace.resolve(relative), stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new WorkspaceError("A selected file is linked or exceeds its size limit.");
    return { path: relative, name: path.basename(relative), revision: revision(stat), size: stat.size, limit };
  }
  async read(file) {
    const absolute = await this.workspace.resolve(file.path);
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (revision(await handle.stat()) !== file.revision) throw new WorkspaceError("A selected file changed. Select the summaries and mappings again.");
      const bytes = await handle.readFile();
      if (revision(await handle.stat()) !== file.revision || bytes.length !== file.size) throw new WorkspaceError("A selected file changed while reading. Select it again.");
      return bytes;
    } finally { await handle.close(); }
  }
  async sources() {
    try {
      return (await this.publicFiles.listDirectory(SOURCE_FOLDER)).entries.filter(e => e.type === "directory").map(e => ({ path: e.path, name: e.name }));
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async select(relative) {
    if (typeof relative !== "string" || !relative.startsWith(`${SOURCE_FOLDER}/`)) throw new WorkspaceError("Choose a report-set folder inside redacted/Patient Summaries.");
    await this.publicFiles.resolve(relative);
    const reports = await this.reportEntries(relative);
    if (!reports.length || reports.length > 2000) throw new WorkspaceError("Choose a folder containing 1–2,000 patient Word summaries.");
    const files = [];
    for (const report of reports.sort((a, b) => a.name.localeCompare(b.name))) files.push(await this.snapshot(report.path));
    if (files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new WorkspaceError("Use a Word report set of at most 64 MiB.");
    let evidence;
    try { evidence = await this.snapshot(`${relative}/evidence.json`, 64 * 1024 * 1024); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const selected = { id: randomUUID(), path: relative, name: path.basename(relative), files, mappings: [], evidence };
    this.selections.set(selected.id, selected);
    return this.view(selected);
  }
  async reportEntries(relative) {
    const directory = await this.workspace.resolve(relative);
    const names = await fs.readdir(directory);
    if (names.length > 5000) throw new WorkspaceError("The selected summary folder contains too many files.");
    // Include linked DOCX names here so snapshot validation rejects them instead
    // of silently dropping a patient's report from the output set.
    return names.filter(name => /\.docx$/i.test(name)).map(name => ({ name, path: `${relative}/${name}` }));
  }
  view(selected) { return { id: selected.id, path: selected.path, name: selected.name, documentCount: selected.files.length, mappingCount: selected.mappings.length }; }
  async selectMappings(id, paths) {
    const source = this.selections.get(id);
    if (!source) throw new WorkspaceError("Choose the patient summary folder first.");
    if (!Array.isArray(paths) || !paths.length || paths.length > 32 || new Set(paths).size !== paths.length) throw new WorkspaceError("Choose 1–32 matching mapping CSVs.");
    const mappings = [];
    for (const relative of paths) {
      if (typeof relative !== "string" || !relative.startsWith("unredacted/") || !/\.csv$/i.test(relative)) throw new WorkspaceError("Choose mapping CSVs inside this workspace's unredacted folder.");
      mappings.push(await this.snapshot(relative));
    }
    if (mappings.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) throw new WorkspaceError("Selected mappings must total at most 40 MiB.");
    const selected = { ...source, id: randomUUID(), mappings };
    this.selections.set(selected.id, selected);
    return this.view(selected);
  }
  capability(id) {
    const source = this.selections.get(id);
    if (!source?.mappings.length) throw new WorkspaceError("Choose a summary folder and its mapping CSVs first.");
    const controller = new AbortController();
    let used = false;
    const cancel = () => controller.abort();
    this.pending.add(cancel);
    return {
      ready: Promise.resolve(), tools: [TOOL], adapter: "unredaction-tools.cjs", historyScope: "restoration",
      systemPrompt: require("./skills.cjs").UNREDACTION_SKILL,
      context: JSON.stringify({ document_count: source.files.length, mapping_count: source.mappings.length, mapping_columns: HEADERS }),
      cancel: () => { cancel(); this.pending.delete(cancel); },
      call: async (name, args) => {
        if (name !== TOOL.name) throw new WorkspaceError("Only the local identity-restoration capability is available.");
        const plan = validatePlan(args);
        if (used || controller.signal.aborted) throw new WorkspaceError("This restoration request has already run or stopped. Submit another message to retry.");
        used = true;
        try { return await this.execute(source, plan, controller.signal); }
        catch (error) { throw new WorkspaceError(error instanceof WorkspaceError ? error.message : "Local restoration could not complete. Check the selected files locally."); }
        finally { this.pending.delete(cancel); }
      },
    };
  }
  async check(source, signal) {
    if (signal.aborted) throw new WorkspaceError("Identity restoration stopped.");
    const entries = (await this.reportEntries(source.path)).map(e => e.path).sort();
    if (JSON.stringify(entries) !== JSON.stringify(source.files.map(f => f.path).sort())) throw new WorkspaceError("The summary set changed. Select it again.");
    for (const file of [...source.files, ...source.mappings, ...(source.evidence ? [source.evidence] : [])]) {
      if ((await this.snapshot(file.path, file.limit)).revision !== file.revision) throw new WorkspaceError("A selected file changed. Select the summaries and mappings again.");
    }
    if (signal.aborted) throw new WorkspaceError("Identity restoration stopped.");
  }
  async execute(source, plan, signal) {
    await this.check(source, signal);
    const documents = [], mappings = [], hashes = [];
    let evidence;
    for (const file of [...source.files, ...source.mappings, ...(source.evidence ? [source.evidence] : [])]) {
      if (signal.aborted) throw new WorkspaceError("Identity restoration stopped.");
      const bytes = await this.read(file); hashes.push({ path: file.path, sha256: digest(bytes) });
      if (file === source.evidence) evidence = bytes;
      else if (source.files.includes(file)) documents.push({ name: file.name, bytes }); else mappings.push(bytes);
    }
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "unredaction-worker.cjs"), { workerData: { documents, mappings }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
      let finished = false;
      const finish = (error, value) => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener("abort", abort); worker.terminate();
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new WorkspaceError("Identity restoration stopped."));
      const timer = setTimeout(() => finish(new WorkspaceError("Identity restoration exceeded 60 seconds. Use a smaller report set.")), 60000);
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", message => finish(message.error ? new WorkspaceError(message.error) : null, message.result));
      worker.once("error", () => finish(new WorkspaceError("The local restoration worker failed or exceeded its memory limit.")));
      worker.once("exit", () => finish(new WorkspaceError("The local restoration worker stopped before completion.")));
      if (signal.aborted) abort();
    });
    await this.check(source, signal);
    const privateRoot = await this.workspace.resolve("unredacted");
    try { await fs.mkdir(path.join(privateRoot, "Patient Summaries"), { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const parent = await this.workspace.resolve(OUTPUT_FOLDER);
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const staging = path.join(parent, `.arma-restore-${id}`);
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      const configuration = { root: this.workspace.root, source: source.path, mappings: source.mappings.map(f => f.path), expected: hashes, plan };
      const script = `// Generated by ARMa. Mapping values and restored documents stay local.\nconst { runSavedUnredaction } = require(${JSON.stringify(path.join(__dirname, "unredaction.cjs"))});\nrunSavedUnredaction(${JSON.stringify(configuration, null, 2)}).then(result => process.stdout.write(result.documentCount + ' patient summaries restored locally.\\n')).catch(() => { process.stderr.write('Identity restoration failed. Check the selected files locally.\\n'); process.exitCode = 1; });\n`;
      const files = [...result.files, ...(evidence ? [{ name: "evidence.json", bytes: evidence }] : []), { name: "unredact.cjs", bytes: script }, { name: "restoration-plan.json", bytes: JSON.stringify(plan, null, 2) }, { name: "restoration-audit.json", bytes: JSON.stringify({ version: 1, created_utc: new Date().toISOString(), sources: hashes, reports: source.files.map((file, index) => ({ source: file.path, restored: result.files[index].name })), documentCount: result.documentCount, replacements: result.replacements }, null, 2) }];
      for (const file of files) {
        if (signal.aborted) throw new WorkspaceError("Identity restoration stopped.");
        if (path.basename(file.name) !== file.name || file.name.startsWith(".")) throw new WorkspaceError("Invalid local restoration output.");
        await fs.writeFile(path.join(staging, file.name), file.bytes, { flag: "wx", mode: 0o600 });
      }
      await this.check(source, signal);
      if (await this.workspace.resolve(OUTPUT_FOLDER) !== parent) throw new WorkspaceError("The output folder changed. Retry the restoration.");
      await fs.rename(staging, path.join(parent, id));
      this.changed();
      // Deliberate whitelist: never forward private worker output or filenames.
      return { status: "saved", path: `${OUTPUT_FOLDER}/${id}`, documentCount: result.documentCount, replacements: result.replacements };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  dispose() { for (const cancel of this.pending) cancel(); this.pending.clear(); this.selections.clear(); }
}
async function runSavedUnredaction(configuration) {
  const workspace = new Workspace(); await workspace.open(configuration.root);
  const service = new UnredactionService(workspace);
  try {
    const selected = await service.select(configuration.source);
    const bound = await service.selectMappings(selected.id, configuration.mappings);
    const actual = service.selections.get(bound.id);
    const files = [...actual.files, ...actual.mappings, ...(actual.evidence ? [actual.evidence] : [])];
    if (!Array.isArray(configuration.expected) || configuration.expected.length !== files.length) throw new WorkspaceError("The saved restoration inputs changed.");
    for (const file of files) if (configuration.expected.find(f => f.path === file.path)?.sha256 !== digest(await service.read(file))) throw new WorkspaceError("The saved restoration inputs changed.");
    return await service.capability(bound.id).call(TOOL.name, { schema_json: JSON.stringify(configuration.plan) });
  } finally { service.dispose(); }
}
module.exports = { UnredactionService, runSavedUnredaction };
