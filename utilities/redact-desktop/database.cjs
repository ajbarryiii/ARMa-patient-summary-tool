"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { constants } = require("node:fs");
const { Worker } = require("node:worker_threads");
const { randomUUID } = require("node:crypto");
const { WorkspaceTools, WorkspaceError } = require("./workspace-tools.cjs");
const EXTENSIONS = new Set([".xlsx", ".csv", ".tsv", ".sqlite", ".db"]);
const revision = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

class DatabaseService {
  constructor(workspace, changed = () => {}) {
    this.files = new WorkspaceTools(workspace.root);
    this.changed = changed;
    this.selections = new Map();
    this.active = new Set();
    this.conversations = new Map();
  }
  async select(relative) {
    if (typeof relative !== "string") throw new WorkspaceError("Choose a report path inside the workspace.");
    const { stat } = await this.files.resolve(relative);
    const extension = path.extname(relative).toLowerCase();
    const limit = [".sqlite",".db"].includes(extension) ? 256*1024*1024 : 40*1024*1024;
    if (!EXTENSIONS.has(extension) || !stat.isFile() || stat.size > limit) throw new WorkspaceError("Choose an XLSX/CSV/TSV report up to 40 MiB or SQLite database up to 256 MiB.");
    const source = { id: randomUUID(), path: relative, name: path.basename(relative), extension, limit, revision: revision(stat) };
    this.selections.set(source.id,source);
    return { id: source.id, path: source.path, name: source.name };
  }
  async sources() {
    const files = [];
    let visited = 0;
    const visit = async directory => {
      for (const item of (await this.files.listDirectory(directory)).entries) {
        if (++visited > 2000) return;
        if (item.type === "directory") await visit(item.path);
        else if (EXTENSIONS.has(path.extname(item.path).toLowerCase())) files.push({ path: item.path, name: item.name });
      }
    };
    await visit("redacted");
    return files;
  }
  capability(id, readOnly = false) {
    const source = this.selections.get(id);
    if (!source) throw new WorkspaceError("Choose the report again.");
    if (readOnly && ![".sqlite", ".db"].includes(source.extension)) throw new WorkspaceError("Choose a saved SQLite database for patient summaries.");
    let worker, loading, waiting, stopped = false, busy = false, sequence = 0;
    const cancel = () => {
      stopped = true;
      worker?.terminate();
      waiting?.reject(new WorkspaceError("Database conversion stopped."));
      this.active.delete(cancel);
    };
    this.active.add(cancel);
    const check = async () => {
      if (stopped) throw new WorkspaceError("Database conversion stopped.");
      const file = await this.files.resolve(source.path);
      if (revision(file.stat) !== source.revision) throw new WorkspaceError("The source changed. Select it again.");
      return file;
    };
    const waitFor = send => new Promise((resolve,reject) => {
      const timer = setTimeout(() => { cancel(); reject(new WorkspaceError("Database processing exceeded 60 seconds. Use a smaller report or simpler SQL.")); },60000);
      waiting = { resolve: value => { clearTimeout(timer); waiting = null; resolve(value); }, reject: error => { clearTimeout(timer); waiting = null; reject(error); } };
      send();
    });
    const load = async () => {
      const file = await check();
      const handle = await fs.open(file.absolute,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        if (revision(await handle.stat()) !== source.revision) throw new WorkspaceError("The source changed. Select it again.");
        bytes = await handle.readFile();
        if (revision(await handle.stat()) !== source.revision || bytes.length > source.limit) throw new WorkspaceError("The source changed. Select it again.");
      } finally { await handle.close(); }
      await check();
      return waitFor(() => {
        worker = new Worker(path.join(__dirname,"database-worker.cjs"), { workerData: { bytes, extension: source.extension, sourceName: source.name, readOnly }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
        worker.on("message", message => {
          if (!waiting) return;
          message.error ? waiting.reject(new WorkspaceError(message.error)) : waiting.resolve(message.result || message);
        });
        worker.on("error", () => { waiting?.reject(new WorkspaceError("The local database worker failed or exceeded its memory limit.")); cancel(); });
        worker.on("exit", () => { if (!stopped) { waiting?.reject(new WorkspaceError("The local database worker stopped.")); cancel(); } });
      });
    };
    return {
      sourceName: source.name,
      sourceId: source.id,
      cancel,
      call: async (name,args) => {
        if (!(readOnly ? ["report_sql", "create_patient_summaries"] : ["report_sql","save_database"]).includes(name)) throw new WorkspaceError("That database capability is unavailable.");
        if (busy || stopped) throw new WorkspaceError("This database turn is busy or stopped.");
        busy = true;
        try {
          await (loading ||= load());
          await check();
          const result = await waitFor(() => worker.postMessage({ id: ++sequence,name,args }));
          if (name === "create_patient_summaries") {
            const saved = await require("./patient-summary-files.cjs").saveSummarySet(this.files, result, check);
            this.changed();
            return saved;
          }
          if (name !== "save_database") return result;
          await check();
          const basename = path.basename(source.name,source.extension).slice(0,100);
          const relative = `redacted/${basename}.${randomUUID()}.sqlite`;
          const destination = await this.files.resolve(relative,true);
          const handle = await fs.open(destination.absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),0o600);
          try { await handle.writeFile(Buffer.from(result.bytes)); } catch (error) { await handle.close(); await fs.unlink(destination.absolute).catch(()=>{}); throw error; }
          await handle.close();
          if (stopped) { await fs.unlink(destination.absolute).catch(()=>{}); throw new WorkspaceError("Database conversion stopped."); }
          this.changed();
          return { path: relative, tables: result.tables, sourceRows: result.sourceRows, status: "saved" };
        } finally { busy = false; }
      },
    };
  }
  summaryAccess(sourceId) {
    const capability = this.capability(sourceId, true);
    return {
      ...capability, ready: this.files.ready,
      tools: [{ ...require("./database-tools.cjs").TOOLS[0], description: "Inspect the selected saved SQLite database with read-only SQL. Inspect sqlite_master for its schema. No writes, attached databases, or file operations. Results are bounded to 100 rows per result and 48,000 characters." }, ...require("./patient-summary-tools.cjs").TOOLS],
      instructions: require("./skills.cjs").PATIENT_SUMMARY_SKILL,
      context: JSON.stringify({ report: this.selections.get(sourceId).path, read_only: true }),
    };
  }
  agentAccess(key, sourceId) {
    if (typeof key !== "string" || !key || key.length > 300) throw new WorkspaceError("Invalid conversation.");
    let session=this.conversations.get(key);
    if (!session) {
      session={}; this.conversations.set(key,session);
      if (this.conversations.size>100) this.conversations.delete(this.conversations.keys().next().value);
    }
    const selected=sourceId ? this.selections.get(sourceId) : undefined;
    if (sourceId && !selected) throw new WorkspaceError("Choose the report again.");
    // Repeated follow-ups with the same composer selection retain the saved database.
    if (selected && session.selectionId!==sourceId) {
      Object.assign(session,{selectionId:sourceId,path:selected.path,sourcePath:selected.path,savedPath:null});
    }
    let active, summary, summaryBusy=false, stopped=false;
    const open=async relative=>{
      if(stopped) throw new WorkspaceError("Workspace operation stopped.");
      const selection=await this.select(relative);
      const next=this.capability(selection.id);
      active?.cancel(); active=next;
      this.selections.delete(selection.id);
      try {
        const schema=await next.call("report_sql",{sql:"SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"});
        if(stopped) throw new WorkspaceError("Workspace operation stopped.");
        session.path=relative;
        if(![".sqlite",".db"].includes(path.extname(relative).toLowerCase())) session.sourcePath=relative;
        return {path:relative,schema};
      } catch(error) {next.cancel();throw error;}
    };
    const {TOOLS}=require("./agent-tools.cjs");
    return {
      ready:this.files.ready, tools:TOOLS,
      sourceName:selected?.name,
      context:JSON.stringify({report:session.path || null,source_report:session.sourcePath || null,saved_database:session.savedPath || null}),
      cancel:()=>{stopped=true;active?.cancel();summary?.cancel();},
      call:async(name,args)=>{
        if(stopped) throw new WorkspaceError("Workspace operation stopped.");
        if(name==="create_patient_summaries") {
          if (!session.path) throw new WorkspaceError("Open the saved SQLite database first.");
          if (summaryBusy) throw new WorkspaceError("Patient summary generation is already running.");
          summaryBusy = true;
          let selected;
          try {
            selected = await this.select(session.path);
            summary = this.capability(selected.id, true);
            if (stopped) { summary.cancel(); throw new WorkspaceError("Workspace operation stopped."); }
            return await summary.call(name, args);
          } finally { summary?.cancel(); summary = null; summaryBusy = false; if (selected) this.selections.delete(selected.id); }
        }
        if(name==="open_report") {
          if(!args || Object.keys(args).length!==1 || typeof args.path!=="string") throw new WorkspaceError("Provide a report path.");
          return open(args.path);
        }
        if(!["report_sql","save_database"].includes(name)) return this.files.call(name,args);
        if(!active) {
          if(!session.path) throw new WorkspaceError("Use open_report with the report or database path first.");
          await open(session.path);
        }
        const result=await require("./database-tools.cjs").createDatabaseTools(active).call(name,args);
        if(name==="save_database") {session.savedPath=result.path;session.path=result.path;}
        return result;
      },
    };
  }
  dispose() { for (const cancel of [...this.active]) cancel(); this.selections.clear(); this.conversations.clear(); }
}
module.exports = { DatabaseService };
