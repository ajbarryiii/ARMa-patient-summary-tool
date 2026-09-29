"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const initSqlJs = require("sql.js");
const JSZip = require("jszip");
const { SaxesParser } = require("saxes");
const { collectPatients, summarize, wordDocument, money } = require("../patient-summaries.cjs");
const { DatabaseService } = require("../database.cjs");
const { Workspace } = require("../workspace.cjs");
const { claudeArguments } = require("../agents.cjs");
const { mapping, populate } = require("./patient-summary-fixture.cjs");

async function database(t) {
  const SQL = await initSqlJs(), db = new SQL.Database();
  populate(db); t.after(() => db.close()); return db;
}
async function fixture(t) {
  const db = await database(t), root = await fs.mkdtemp(path.join(os.tmpdir(), "arma-summaries-"));
  const workspace = new Workspace(); await workspace.open(root);
  const service = new DatabaseService(workspace);
  await fs.writeFile(path.join(root, "redacted/patients.sqlite"), db.export());
  const selected = await service.select("redacted/patients.sqlite");
  t.after(async () => { service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { db, root, service, selected };
}

test("summaries preserve cents, adjustments, separate suppliers, empty patients, and the $200 floor", async t => {
  const db = await database(t), { patients, excluded } = collectPatients(db, mapping);
  assert.equal(patients.length, 4); assert.equal(excluded, 1);
  const [high, low, other, empty] = patients.map(p => summarize(p, mapping));
  assert.equal(high.total, 9010000n); assert.equal(high.known, 3);
  assert.equal(high.activity, 11010000n);
  assert.deepEqual(high.included.map(g => g.service), ["Inpatient care", "Adjustment", "Surgery"]);
  assert.equal(high.individualPending.length, 1);
  assert.equal(high.individualPending[0].amount, 5000001n);
  assert.match(high.diagnosis, /^Inferred:.*hypertension/i);
  assert.equal(high.diagnosisEvidence[0].reference_id.length > 0, true);
  assert.equal(low.total, 39999n); assert.equal(low.included.length, 0);
  assert.match(low.diagnosis, /^Recorded: Recorded condition$/);
  assert.equal(other.total, 20001n); assert.equal(other.included.length, 1);
  assert.match(other.diagnosis, /^Unknown/); assert.equal(other.exceptions.length, 2);
  assert.equal(empty.total, 0n); assert.equal(empty.observations.length, 0);
  assert.equal(money(900719925474099123n), "$9,007,199,254,740,991.23");
});

test("5 percent boundary, large paid groups, and pending totals are exact", async t => {
  const db = await database(t);
  db.run("DELETE FROM events; DELETE FROM patients;");
  db.run("INSERT INTO patients VALUES ('A','1','A');");
  for (const [line, amount] of [[1, 949999], [2, 50000], [3, 1]]) db.run("INSERT INTO events(supplier,patient,label,line,paid,pending,service) VALUES ('A','1','A',?,?,3000000,?)", [line, amount, `Service ${line}`]);
  let result = summarize(collectPatients(db, mapping).patients[0], mapping);
  assert.deepEqual(result.included.map(g => g.service), ["Service 1", "Service 2"]);
  assert.equal(result.pending, 9000000n); assert.equal(result.individualPending.length, 0);
  db.run("UPDATE events SET paid=49999 WHERE line=2; UPDATE events SET paid=2 WHERE line=3");
  result = summarize(collectPatients(db, mapping).patients[0], mapping);
  assert.deepEqual(result.included.map(g => g.service), ["Service 1"]);
  db.run("UPDATE events SET paid=1000000000 WHERE line=1; UPDATE events SET paid=5000000 WHERE line=2");
  result = summarize(collectPatients(db, mapping).patients[0], mapping);
  assert.deepEqual(result.included.map(g => g.service), ["Service 1", "Service 2"]);
});

test("invalid mappings and duplicated observations cannot inflate payments", async t => {
  const db = await database(t);
  assert.throws(() => collectPatients(db, { ...mapping, net_payment_cents: "SUM(paid)" }), /Missing mapped/);
  assert.throws(() => collectPatients(db, { ...mapping, sql: "SELECT 1" }), /Invalid/);
  assert.throws(() => collectPatients(db, { ...mapping, patient_key: ["patient"] }), /match/);
  db.run("INSERT INTO events SELECT * FROM events WHERE line=1");
  assert.throws(() => collectPatients(db, mapping), /Duplicate observation/);
  db.run("DELETE FROM events WHERE rowid=(SELECT MAX(rowid) FROM events); UPDATE events SET paid=0.5 WHERE line=1");
  assert.throws(() => collectPatients(db, mapping), /integer cents/);
  db.run("UPDATE events SET paid=NULL, patient=NULL WHERE line=1");
  assert.throws(() => collectPatients(db, mapping), /patient key/);
});

test("Word output has Calibri 12 pt, sized headings, genuine bullets, escaped text and missing-data notes", async t => {
  const db = await database(t), { patients } = collectPatients(db, mapping);
  patients[0].label = "PATIENT <A> & B";
  const doc = await JSZip.loadAsync(await wordDocument(summarize(patients[0], mapping), mapping, "claims.sqlite"));
  for (const file of Object.values(doc.files).filter(f => !f.dir)) new SaxesParser({ xmlns: true }).write(await file.async("string")).close();
  const styles = await doc.file("word/styles.xml").async("string"), content = await doc.file("word/document.xml").async("string");
  assert.match(styles, /Calibri/); assert.match(styles, /w:sz w:val="24"/); assert.match(styles, /w:sz w:val="40"/); assert.match(styles, /w:sz w:val="28"/);
  assert.match(content, /w:numPr/); assert.match(content, /PATIENT &lt;A&gt; &amp; B/);
  assert.match(content, /\$90,100.00 \(partial; 1 amount missing\)/);
  assert.match(content, /−\$10,000.00/); assert.match(content, /\$50,000.01/);
  assert.doesNotMatch(content, /Office visit/);
  const low = await JSZip.loadAsync(await wordDocument(summarize(patients[1], mapping), mapping, "claims.sqlite"));
  assert.match(await low.file("word/document.xml").async("string"), /No events over \$200/);
  const empty = await JSZip.loadAsync(await wordDocument(summarize(patients[3], mapping), mapping, "claims.sqlite"));
  assert.match(await empty.file("word/document.xml").async("string"), /Pending amounts are not recorded/);
});

test("read-only capability publishes complete immutable sets from the saved database", async t => {
  const { root, service, selected } = await fixture(t), before = await fs.readFile(path.join(root, selected.path));
  const access = service.summaryAccess(selected.id);
  assert.deepEqual(access.tools.map(t => t.name), ["report_sql", "create_patient_summaries"]);
  const args = claudeArguments(root, root, "private-pipe", false, access);
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__workspace__report_sql,mcp__workspace__create_patient_summaries");
  assert.match(args[args.indexOf("--system-prompt") + 1], /name: patient-summaries/);
  await assert.rejects(access.call("report_sql", { sql: "UPDATE events SET paid=999" }), /readonly/);
  await assert.rejects(access.call("save_database", { tables: ["events"] }), /unavailable/);
  const saved = await access.call("create_patient_summaries", { mapping });
  assert.equal(saved.status, "saved"); assert.equal(saved.patientCount, 4);
  assert.match(saved.path, /^redacted\/Patient Summaries\//);
  const names = await fs.readdir(path.join(root, saved.path));
  assert.equal(names.filter(n => n.endsWith(".docx")).length, 4);
  const evidence = JSON.parse(await fs.readFile(path.join(root, saved.path, "evidence.json"), "utf8"));
  assert.equal(evidence.reports[0].total, "9010000");
  assert.deepEqual(evidence.reports[0].included[0].evidence, [["A", 1]]);
  assert.equal(evidence.source_sha256.length, 64);
  const again = await access.call("create_patient_summaries", { mapping });
  assert.notEqual(again.path, saved.path);
  assert.deepEqual(await fs.readFile(path.join(root, selected.path)), before);
  access.cancel();
  const chat = service.agentAccess("followup", selected.id);
  await chat.call("report_sql", { sql: "UPDATE events SET paid=1" });
  const fresh = await chat.call("create_patient_summaries", { mapping });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, fresh.path, "evidence.json"))).reports[0].total, "9010000");
  chat.cancel();
});

test("changed sources, invalid mappings, cancellation and linked output folders cannot publish", async t => {
  const { root, service, selected } = await fixture(t);
  const cancelled = service.summaryAccess(selected.id); cancelled.cancel();
  await assert.rejects(cancelled.call("create_patient_summaries", { mapping }), /stopped/);
  const invalid = service.summaryAccess(selected.id);
  await assert.rejects(invalid.call("create_patient_summaries", { mapping: { ...mapping, net_payment_cents: "missing" } }), /Missing mapped/);
  assert.deepEqual(await fs.readdir(path.join(root, "redacted")), ["patients.sqlite"]);
  await fs.symlink(path.join(root, "unredacted"), path.join(root, "redacted/Patient Summaries"));
  await assert.rejects(invalid.call("create_patient_summaries", { mapping }), /ordinary|Linked/);
  assert.deepEqual(await fs.readdir(path.join(root, "unredacted")), ["Mapping CSV columns.md"]);
  await fs.appendFile(path.join(root, selected.path), "changed");
  await assert.rejects(invalid.call("create_patient_summaries", { mapping }), /source changed/);
});

test("in-flight cancellation leaves no reports and concurrent chat generation is rejected", async t => {
  const { root, service, selected } = await fixture(t);
  const access = service.agentAccess("cancel", selected.id);
  const generation = assert.rejects(access.call("create_patient_summaries", { mapping }), /stopped/);
  await assert.rejects(access.call("create_patient_summaries", { mapping }), /already running/);
  setImmediate(() => access.cancel());
  await generation;
  assert.deepEqual(await fs.readdir(path.join(root, "redacted")), ["patients.sqlite"]);
});
