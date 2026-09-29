"use strict";
const path = require("node:path");
const { Worker } = require("node:worker_threads");

// Parsing is isolated from Electron's event loop and can be stopped when the
// operator switches files/workspaces. Only the already-authorized bytes enter it.
class DocumentPreview {
  clear() {
    this.cancel();
    this.cache = null;
  }
  cancel() {
    if (this.pending) {
      this.pending.reject(new Error("Preview cancelled."));
      clearTimeout(this.pending.timer);
      this.pending.worker.terminate();
      this.pending = null;
    }
  }

  async load(file, sheetIndex = -1) {
    if (!Number.isInteger(sheetIndex) || sheetIndex < -1 || sheetIndex >= 64)
      throw new Error("Invalid worksheet selection.");
    this.cancel();
    const key = `${file.path}:${file.revision}:${sheetIndex}`;
    if (this.cache?.key === key) return this.cache.file;
    if (file.kind !== "spreadsheet") return file;
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        path.join(__dirname, "spreadsheet-preview.cjs"),
        {
          workerData: {
            bytes: file.data,
            extension: path.extname(file.name).toLowerCase(),
            sheetIndex,
          },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        },
      );
      const finish = (error, workbook) => {
        if (this.pending?.worker !== worker) return;
        clearTimeout(this.pending.timer);
        this.pending = null;
        worker.terminate();
        if (error) reject(error);
        else {
          const { data, ...metadata } = file;
          const result = { ...metadata, workbook };
          this.cache = { key, file: result };
          resolve(result);
        }
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "This workbook took too long to preview. Try a smaller workbook.",
            ),
          ),
        30000,
      );
      this.pending = { worker, timer, reject };
      worker.once("message", (result) =>
        finish(result.error ? new Error(result.error) : null, result.workbook),
      );
      worker.once("error", () =>
        finish(
          new Error(
            "This workbook could not be previewed within the memory limit.",
          ),
        ),
      );
      worker.once("exit", (code) => {
        if (this.pending?.worker === worker)
          finish(
            new Error(
              `The workbook preview stopped${code ? " unexpectedly" : ""}.`,
            ),
          );
      });
    });
  }
}
module.exports = { DocumentPreview };
