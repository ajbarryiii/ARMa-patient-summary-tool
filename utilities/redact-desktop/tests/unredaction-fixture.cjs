"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const JSZip = require("jszip");
const { Workspace } = require("../workspace.cjs");
const { RedactionService } = require("../redaction.cjs");
const { parseCSV } = require("../unredaction-worker.cjs");
const { wordDocument } = require("../patient-summaries.cjs");

const PRIVATE_NAME = 'Alex "Example", <Test> & Co';
const PRIVATE_ID = "000123";
async function makeFixture(root) {
  const workspace = new Workspace(); await workspace.open(root);
  const redaction = new RedactionService(workspace);
  await fs.writeFile(path.join(root, "unredacted/patients.csv"), `name,id\n"${PRIVATE_NAME.replace(/"/g, '""')}",${PRIVATE_ID}\n`);
  const source = await redaction.select("unredacted/patients.csv");
  await redaction.capability(source.id).run(JSON.stringify({ version: 1, rules: [
    { field: "patient_name", prefix: "PERSON", scope: "column", column: "A" },
    { field: "member_id", prefix: "MEMBER", scope: "column", column: "B" },
  ] }));
  const [job] = await redaction.jobs(); await redaction.approve(job.id);
  const csv = await fs.readFile(path.join(root, job.mapping));
  const rows = parseCSV(csv).slice(1), name = rows.find(row => row[0] === "patient_name")[2], id = rows.find(row => row[0] === "member_id")[2];
  const report = { label: name, key: [id], total: 12000000n, observations: [{}], known: 1, pending: 6000000n, pendingKnown: 1, diagnosis: "Recorded: Example diagnosis", included: [{ dos: "2026-06-01", service: "Inpatient care", net: 12000000n, pending: 6000000n, known: 1, pendingKnown: 1, evidence: [[1]] }], omitted: [], individualPending: [], exceptions: [] };
  const zip = await JSZip.loadAsync(await wordDocument(report, { table: "events", pending_cents: "pending" }, "patients.sqlite"));
  let xml = await zip.file("word/document.xml").async("string");
  // Simulate a Word edit splitting a token into runs with different formatting.
  xml = xml.replace(name, `${name.slice(0, 10)}</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>${name.slice(10)}`);
  zip.file("word/document.xml", xml);
  const folder = "redacted/Patient Summaries/synthetic-set";
  await fs.mkdir(path.join(root, folder), { recursive: true });
  const document = `${folder}/0001 ${name}.docx`, bytes = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(path.join(root, document), bytes);
  await fs.writeFile(path.join(root, folder, "evidence.json"), JSON.stringify({ version: 1, reports: [{ label: name, key: [id], total: "12000000" }] }));
  redaction.dispose();
  return { workspace, folder, document, bytes, mapping: job.mapping, csv, name, id };
}
module.exports = { makeFixture, PRIVATE_NAME, PRIVATE_ID };
