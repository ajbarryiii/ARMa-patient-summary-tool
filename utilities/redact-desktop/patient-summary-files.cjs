"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Only trusted worker output reaches this writer; no provider-supplied paths.
async function saveSummarySet(files, result, check) {
  const folder = "redacted/Patient Summaries";
  let parent = await files.resolve(folder, true);
  if (!parent.stat) await fs.mkdir(parent.absolute, { mode: 0o700 });
  parent = await files.resolve(folder);
  if (!parent.stat.isDirectory()) throw new Error("Patient Summaries must be a directory.");
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const staging = path.join(parent.absolute, `.arma-summaries-${id}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const file of result.files) {
      await check();
      if (path.basename(file.name) !== file.name || file.name.startsWith(".")) throw new Error("Invalid report filename.");
      await fs.writeFile(path.join(staging, file.name), file.bytes, { flag: "wx", mode: 0o600 });
    }
    await check();
    const destination = await files.resolve(`${folder}/${id}`, true);
    if (destination.stat) throw new Error("Report set already exists.");
    await fs.rename(staging, destination.absolute);
    return { status: "saved", path: `${folder}/${id}`, patientCount: result.patientCount, diagnosisUnknown: result.diagnosisUnknown, missingPaymentCount: result.missingPaymentCount };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
module.exports = { saveSummarySet };
