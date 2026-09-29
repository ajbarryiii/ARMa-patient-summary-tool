"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { randomUUID, createHash } = require("node:crypto");
const { Workspace } = require("./workspace.cjs");
const {
  validateSchema,
  RedactionError,
  EXTENSIONS,
  LIMIT,
} = require("./redaction-schema.cjs");
const RUNS = "unredacted/redaction-runs";
const revision = (stat) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const idPattern = /^[a-f0-9-]{36}$/;

function workerFailure(error) {
  // Never expose raw worker exceptions: parser errors may contain source data.
  if (error?.code === "ERR_WORKER_OUT_OF_MEMORY")
    return new RedactionError(
      "The local redaction worker exceeded its 384 MiB memory limit. Use a smaller workbook copy or update the application. The original was not changed.",
    );
  if (["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(error?.code))
    return new RedactionError(
      "The local redaction worker could not load an application dependency. Reinstall the app dependencies and restart.",
    );
  return new RedactionError(
    "The local redaction worker stopped unexpectedly. Restart the application and retry. The original was not changed.",
  );
}

class RedactionService {
  constructor(workspace, changed = () => {}) {
    this.workspace = workspace;
    this.changed = changed;
    this.selections = new Map();
    this.pending = new Set();
  }
  async select(relative) {
    if (
      typeof relative !== "string" ||
      !relative.startsWith("unredacted/") ||
      relative.startsWith(`${RUNS}/`)
    )
      throw new RedactionError("Choose a source document in unredacted.");
    const absolute = await this.workspace.resolve(relative),
      stat = await fs.lstat(absolute);
    const extension = path.extname(absolute).toLowerCase();
    if (!EXTENSIONS.has(extension))
      throw new RedactionError(
        "Use XLSX, CSV, TSV, or UTF-8 text. Save older Excel files as XLSX first.",
      );
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT)
      throw new RedactionError(
        "Choose an ordinary source file of at most 40 MiB, without links.",
      );
    const selection = {
      id: randomUUID(),
      path: relative,
      name: path.basename(relative),
      extension,
      revision: revision(stat),
    };
    this.selections.set(selection.id, selection);
    return { id: selection.id, path: selection.path, name: selection.name };
  }
  async sources() {
    const files = [];
    let visited = 0;
    const visit = async (relative) => {
      for (const entry of await this.workspace.list(relative)) {
        if (++visited > 2000) return;
        if (entry.path === RUNS || entry.name.startsWith(".")) continue;
        if (entry.kind === "directory") await visit(entry.path);
        else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
          files.push({ name: entry.name, path: entry.path });
      }
    };
    await visit("unredacted");
    return files;
  }
  async read(relative, expectedRevision) {
    const absolute = await this.workspace.resolve(relative);
    const handle = await fs.open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > LIMIT ||
        (expectedRevision && revision(before) !== expectedRevision)
      )
        throw new RedactionError(
          "The source changed. Select it again before redacting.",
        );
      const current = await fs.lstat(await this.workspace.resolve(relative));
      if (revision(current) !== revision(before))
        throw new RedactionError("The file changed. Select it again.");
      const bytes = Buffer.alloc(before.size + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          total,
          bytes.length - total,
          total,
        );
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (
        revision(await handle.stat()) !== revision(before) ||
        total !== before.size
      )
        throw new RedactionError(
          "The file changed while reading. Select it again.",
        );
      return bytes.subarray(0, total);
    } finally {
      await handle.close();
    }
  }
  capability(selectionId) {
    const source = this.selections.get(selectionId);
    if (!source) throw new RedactionError("Choose the source file again.");
    let used = false;
    const controller = new AbortController();
    return {
      sourceName: source.name,
      run: async (schemaJson) => {
        const schema = validateSchema(schemaJson);
        if (used || controller.signal.aborted)
          throw new RedactionError(
            "This request has already run. Ask the operator to submit another redaction request.",
          );
        used = true;
        const job = await this.execute(source, schema, controller.signal);
        return {
          items: job.items,
          file: source.name,
          status: "review_required",
        };
      },
      cancel: () => controller.abort(),
    };
  }
  async execute(source, schema, signal) {
    if (signal?.aborted) throw new RedactionError("Redaction cancelled.");
    const bytes = await this.read(source.path, source.revision);
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "redaction-worker.cjs"), {
        workerData: { bytes, extension: source.extension, schema },
        resourceLimits: { maxOldGenerationSizeMb: 384 },
      });
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(abort);
        worker.terminate();
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(new RedactionError("Redaction cancelled."));
      const timer = setTimeout(
        () =>
          finish(
            new RedactionError(
              "Redaction exceeded the time limit. Simplify the regex or use a smaller file.",
            ),
          ),
        30000,
      );
      this.pending.add(abort);
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", (message) =>
        finish(
          message.error ? new RedactionError(message.error) : null,
          message.result,
        ),
      );
      worker.once("error", (error) => finish(workerFailure(error)));
      worker.once("exit", () =>
        finish(new RedactionError("Redaction stopped before completing.")),
      );
      if (signal?.aborted) abort();
    });
    if (signal?.aborted) throw new RedactionError("Redaction cancelled.");
    // Recheck the selected document before committing local artifacts.
    const current = await fs.lstat(await this.workspace.resolve(source.path));
    if (revision(current) !== source.revision)
      throw new RedactionError(
        "The source changed. Select it again before redacting.",
      );
    const parent = await this.workspace.resolve("unredacted");
    try {
      await fs.mkdir(path.join(parent, "redaction-runs"), { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const runs = await this.workspace.resolve(RUNS),
      id = randomUUID(),
      relative = `${RUNS}/${id}`;
    await fs.mkdir(path.join(runs, id), { mode: 0o700 });
    const directory = await this.workspace.resolve(relative);
    const output = Buffer.from(result.bytes),
      artifact = `redacted${source.extension}`;
    const job = {
      id,
      source: source.path,
      name: source.name,
      items: result.items,
      status: "review_required",
      created: new Date().toISOString(),
      preview: `${relative}/${artifact}`,
      mapping: `${relative}/mapping.csv`,
      script: `${relative}/redact.cjs`,
      schema: `${relative}/schema.json`,
      sourceHash: digest(bytes),
      outputHash: digest(output),
    };
    const script = `// Generated by ARMa from the operator's redaction schema.\n// Originals and mappings stay local; output requires local review.\nconst { runSavedRedaction } = require(${JSON.stringify(path.join(__dirname, "redaction.cjs"))});\nrunSavedRedaction(${JSON.stringify({ root: this.workspace.root, source: source.path, schema }, null, 2)}).then(result => process.stdout.write(result.items + ' items redacted from ' + result.name + '\\n')).catch(() => { process.stderr.write('Redaction failed. Check the source and schema locally.\\n'); process.exitCode = 1; });\n`;
    job.mappingHash = digest(result.mapping);
    job.schemaHash = digest(JSON.stringify(schema, null, 2));
    job.scriptHash = digest(script);
    const write = (name, value) =>
      fs.writeFile(path.join(directory, name), value, {
        flag: "wx",
        mode: 0o600,
      });
    await write(artifact, output);
    await write("mapping.csv", result.mapping);
    await write("schema.json", JSON.stringify(schema, null, 2));
    await write("redact.cjs", script);
    await write("job.json", JSON.stringify(job, null, 2));
    this.changed();
    return job;
  }
  async jobs() {
    let entries;
    try {
      entries = await this.workspace.list(RUNS);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const jobs = [];
    for (const entry of entries.slice(-200)) {
      if (entry.kind !== "directory" || !idPattern.test(entry.name)) continue;
      try {
        const job = await this.job(entry.name);
        jobs.push(job);
      } catch {
        /* Incomplete or modified artifacts are never published. */
      }
    }
    return jobs.sort((a, b) => b.created.localeCompare(a.created));
  }
  async job(id) {
    if (typeof id !== "string" || !idPattern.test(id))
      throw new RedactionError("Choose a redaction result.");
    const job = JSON.parse(
      (await this.read(`${RUNS}/${id}/job.json`)).toString("utf8"),
    );
    if (
      job.id !== id ||
      !["review_required", "published"].includes(job.status) ||
      typeof job.name !== "string" ||
      !Number.isInteger(job.items) ||
      job.items < 0 ||
      typeof job.created !== "string" ||
      !EXTENSIONS.has(path.extname(job.name).toLowerCase()) ||
      !/^[a-f0-9]{64}$/.test(job.outputHash) ||
      !/^[a-f0-9]{64}$/.test(job.sourceHash) ||
      typeof job.source !== "string" ||
      !job.source.startsWith("unredacted/")
    )
      throw new RedactionError("This redaction record is invalid.");
    const base = `${RUNS}/${id}`;
    if (
      job.preview !==
        `${base}/redacted${path.extname(job.name).toLowerCase()}` ||
      job.mapping !== `${base}/mapping.csv` ||
      job.script !== `${base}/redact.cjs` ||
      job.schema !== `${base}/schema.json`
    )
      throw new RedactionError("This redaction record is invalid.");
    return job;
  }
  async approve(id) {
    const job = await this.job(id);
    if (job.status === "published") return job;
    if (!job.items)
      throw new RedactionError(
        "Nothing was replaced. Update the description and run again.",
      );
    const bytes = await this.read(job.preview);
    if (
      digest(bytes) !== job.outputHash ||
      digest(await this.read(job.source)) !== job.sourceHash
    )
      throw new RedactionError(
        "The source or preview changed. Run redaction again before publishing.",
      );
    for (const artifact of ["mapping", "schema", "script"])
      if (digest(await this.read(job[artifact])) !== job[`${artifact}Hash`])
        throw new RedactionError(
          "The redaction artifacts changed. Run redaction again before publishing.",
        );
    const extension = path.extname(job.name),
      basename = path.basename(job.name, extension).slice(0, 120);
    const filename = `${basename}.redacted-${id}${extension.toLowerCase()}`;
    const destination = await this.workspace.resolve("redacted");
    await fs.writeFile(path.join(destination, filename), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    job.status = "published";
    job.output = `redacted/${filename}`;
    const record = await this.workspace.resolve(`${RUNS}/${id}/job.json`);
    // The record contains no source values; only the local GUI can approve it.
    await fs.writeFile(record, JSON.stringify(job, null, 2));
    this.changed();
    return job;
  }
  dispose() {
    for (const cancel of [...this.pending]) cancel();
    this.selections.clear();
  }
}
async function runSavedRedaction({ root, source, schema }) {
  const workspace = new Workspace();
  await workspace.open(root);
  const service = new RedactionService(workspace);
  const selected = await service.select(source);
  return service.execute(
    service.selections.get(selected.id),
    validateSchema(JSON.stringify(schema)),
  );
}
module.exports = { RedactionService, runSavedRedaction, RUNS, workerFailure };
