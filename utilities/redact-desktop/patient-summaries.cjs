"use strict";
const JSZip = require("jszip");
const { lookup } = require("./code-descriptions.cjs");

const LIMIT = 500000;
const PENDING_LIMIT = 5000000n;
const identifier = value => {
  if (typeof value !== "string" || !value.length || value.length > 128 || /[\x00-\x1f]/.test(value)) throw new Error("Use existing table and column names.");
  return `"${value.replace(/"/g, '""')}"`;
};
const text = value => value == null ? "" : String(value).trim();
const abs = value => value < 0n ? -value : value;
const money = value => value == null ? "Unknown" : `${value < 0n ? "−" : ""}$${(abs(value) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(abs(value) % 100n).toString().padStart(2, "0")}`;
const cents = value => {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Payment and pending columns must contain exact integer cents or NULL. Review the financial mapping.");
  return BigInt(value);
};
function object(value, allowed, required) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid patient summary mapping.");
}
function keyColumns(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8 || new Set(value).size !== value.length) throw new Error("Provide distinct patient and observation key columns.");
  value.forEach(identifier);
}
function validateMapping(m) {
  object(m, ["table", "patient_key", "observation_key", "net_payment_cents", "patient_label", "dos", "service_type", "pending_cents", "primary_diagnosis", "icd_code", "cpt_code", "exclude", "patients", "significance_percent"], ["table", "patient_key", "observation_key", "net_payment_cents"]);
  for (const key of ["table", "net_payment_cents", "patient_label", "dos", "service_type", "pending_cents", "primary_diagnosis", "icd_code", "cpt_code"]) if (m[key] !== undefined) identifier(m[key]);
  keyColumns(m.patient_key); keyColumns(m.observation_key);
  if (m.significance_percent !== undefined && (!Number.isFinite(m.significance_percent) || m.significance_percent < 0 || m.significance_percent > 100)) throw new Error("Significance must be between 0 and 100 percent.");
  if (m.exclude) {
    object(m.exclude, ["column", "values"], ["column", "values"]); identifier(m.exclude.column);
    if (!Array.isArray(m.exclude.values) || !m.exclude.values.length || m.exclude.values.length > 32 || m.exclude.values.some(v => !(typeof v === "string" || typeof v === "number" && Number.isFinite(v)))) throw new Error("Provide explicit total-row exclusion values.");
  }
  if (m.patients) {
    object(m.patients, ["table", "key", "label"], ["table", "key"]); identifier(m.patients.table); keyColumns(m.patients.key);
    if (m.patients.label) identifier(m.patients.label);
    if (m.patients.key.length !== m.patient_key.length) throw new Error("Roster and observation patient keys must match in order and type.");
  }
}
function columns(db, table, names) {
  const record = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table]);
  if (!record.length || /\bVIRTUAL\b/i.test(record[0].values[0][0])) throw new Error("Map an ordinary saved observation or patient table.");
  const available = new Set(db.exec(`PRAGMA table_info(${identifier(table)})`)[0].values.map(row => row[1]));
  for (const name of names) if (!available.has(name)) throw new Error(`Missing mapped column: ${name}`);
}
function rows(db, table, names, each) {
  columns(db, table, names);
  const statement = db.prepare(`SELECT ${names.map(identifier).join(",")} FROM ${identifier(table)}`);
  let count = 0;
  try {
    while (statement.step()) {
      if (++count > LIMIT) throw new Error("Patient summaries support up to 500,000 observations.");
      each(statement.getAsObject());
    }
  } finally { statement.free(); }
}
function key(row, names, kind) {
  const values = names.map(name => row[name]);
  if (values.some(v => v == null || !text(v) || !["string", "number"].includes(typeof v) || typeof v === "number" && !Number.isSafeInteger(v))) throw new Error(`Missing or unsafe ${kind} key. Review the mapping.`);
  return JSON.stringify(values);
}
function collectPatients(db, mapping) {
  validateMapping(mapping);
  const patients = new Map(), seen = new Set();
  const add = (id, label) => {
    if (patients.size >= 2000) throw new Error("Use a database with at most 2,000 patients per report set.");
    const patient = { key: JSON.parse(id), label: text(label) || JSON.parse(id).join(" / "), observations: [] };
    patients.set(id, patient); return patient;
  };
  if (mapping.patients) {
    const p = mapping.patients;
    rows(db, p.table, [...new Set([...p.key, ...(p.label ? [p.label] : [])])], row => {
      const id = key(row, p.key, "patient");
      if (patients.has(id)) throw new Error("Duplicate patient keys in the roster. Review patient grouping.");
      add(id, row[p.label]);
    });
  }
  const fields = ["net_payment_cents", "pending_cents", "patient_label", "dos", "service_type", "primary_diagnosis", "icd_code", "cpt_code"];
  const names = [...new Set([...mapping.patient_key, ...mapping.observation_key, ...fields.map(f => mapping[f]).filter(Boolean), ...(mapping.exclude ? [mapping.exclude.column] : [])])];
  let excluded = 0;
  rows(db, mapping.table, names, row => {
    if (mapping.exclude?.values.includes(row[mapping.exclude.column])) { excluded++; return; }
    const id = key(row, mapping.patient_key, "patient"), observation = key(row, mapping.observation_key, "observation");
    if (seen.has(observation)) throw new Error("Duplicate observation keys would duplicate financial amounts. Correct the source mapping.");
    seen.add(observation);
    if (mapping.patients && !patients.has(id)) throw new Error("An observation has no matching roster patient. Review the patient keys.");
    const patient = patients.get(id) || add(id, row[mapping.patient_label]);
    const label = text(row[mapping.patient_label]);
    if (!mapping.patients?.label && label && patient.label !== label) throw new Error("Conflicting labels for one patient key. Review patient grouping.");
    const values = Object.fromEntries(fields.map(f => [f, row[mapping[f]] ?? null]));
    for (const [field, value] of Object.entries(values)) {
      if (!["net_payment_cents", "pending_cents"].includes(field) && value != null && (typeof value === "object" || text(value).length > 2000)) throw new Error("Mapped report text exceeds its supported size.");
    }
    patient.observations.push({ ...values, source: JSON.parse(observation), net: cents(values.net_payment_cents), pending: cents(values.pending_cents) });
  });
  if (!patients.size) throw new Error("No patients were found. Review the patient table and exclusions.");
  return { patients: [...patients.values()], excluded };
}
function summarize(patient, mapping) {
  let total = 0n, activity = 0n, pending = 0n, known = 0, pendingKnown = 0;
  const groups = new Map(), recorded = new Map(), diagnoses = new Map(), exceptions = new Map();
  const individualPending = [];
  const reference = (system, value, date) => {
    if (!text(value)) return null;
    const found = lookup(system, value, date);
    if (found.status !== "matched") exceptions.set(JSON.stringify([system, value, date]), found);
    return found;
  };
  for (const row of patient.observations) {
    if (row.net !== null) { total += row.net; activity += abs(row.net); known++; }
    if (row.pending !== null) { pending += row.pending; pendingKnown++; }
    const icd = reference("icd", row.icd_code, row.dos), cpt = reference("cpt", row.cpt_code, row.dos);
    row.code_references = [icd, cpt].filter(Boolean);
    if (text(row.primary_diagnosis)) {
      const value = text(row.primary_diagnosis);
      const primaryCode = /^[A-Z]\d[A-Z0-9](?:\.?[A-Z0-9]{1,4})?$/i.test(value) ? reference("icd", value, row.dos) : null;
      if (primaryCode) row.code_references.push(primaryCode);
      const name = primaryCode?.status === "matched" ? `${primaryCode.description} (ICD-10-CM ${value})` : value;
      if (!recorded.has(name)) recorded.set(name, []);
      recorded.get(name).push(row.source);
    }
    if (icd?.status === "matched") {
      const candidate = diagnoses.get(icd.code) || { ...icd, weight: 0n, evidence: [] };
      candidate.weight += row.net === null ? 0n : abs(row.net); candidate.evidence.push(row.source); diagnoses.set(icd.code, candidate);
    }
    const service = text(row.service_type) || (cpt?.status === "matched" ? cpt.description : text(row.cpt_code) ? `Procedure ${text(row.cpt_code)}` : "Service not recorded");
    const dos = text(row.dos) || "DOS not recorded", id = JSON.stringify([dos, service]);
    const group = groups.get(id) || { dos, service, net: 0n, pending: 0n, activity: 0n, largestPayment: 0n, known: 0, pendingKnown: 0, evidence: [], largePending: false };
    if (row.net !== null) { group.net += row.net; group.activity += abs(row.net); group.largestPayment = abs(row.net) > group.largestPayment ? abs(row.net) : group.largestPayment; group.known++; }
    if (row.pending !== null) { group.pending += row.pending; group.pendingKnown++; }
    group.evidence.push(row.source);
    if (row.pending > PENDING_LIMIT) { group.largePending = true; individualPending.push({ dos, service, amount: row.pending, source: row.source }); }
    groups.set(id, group);
  }
  const percent = mapping.significance_percent ?? 5;
  const included = [], omitted = [];
  for (const group of groups.values()) {
    // Scale to millionths of a percent; keep all financial arithmetic as integers.
    const significant = group.activity > 0n && group.activity * 100000000n >= activity * BigInt(Math.round(percent * 1000000));
    (group.largestPayment > 20000n && (significant || abs(group.net) >= PENDING_LIMIT) || group.pending > PENDING_LIMIT || group.largePending ? included : omitted).push(group);
  }
  included.sort((a, b) => a.dos.localeCompare(b.dos) || a.service.localeCompare(b.service));
  const leading = [...diagnoses.values()].sort((a, b) => a.weight === b.weight ? a.code.localeCompare(b.code) : a.weight > b.weight ? -1 : 1);
  let diagnosis, diagnosisEvidence;
  if (recorded.size) {
    diagnosis = `${recorded.size > 1 ? "Recorded primary diagnoses" : "Recorded"}: ${[...recorded.keys()].join("; ")}`;
    diagnosisEvidence = [...recorded].map(([value, evidence]) => ({ value, evidence }));
  } else if (leading.length && (leading.length === 1 || leading[0].weight > leading[1].weight)) {
    diagnosis = `Inferred: ${leading[0].description} (ICD-10-CM ${leading[0].code}). Leading coded diagnosis by absolute payment activity; primary status is not recorded.`;
    diagnosisEvidence = [leading[0]];
  } else {
    diagnosis = leading.length ? "Unknown. Multiple coded diagnoses have equal payment support; primary status is not recorded." : "Unknown. No primary diagnosis is recorded and available code evidence does not establish one.";
    diagnosisEvidence = leading;
  }
  return { ...patient, total: known || !patient.observations.length ? total : null, activity, pending: pendingKnown ? pending : null, known, pendingKnown, included, omitted, individualPending, diagnosis, diagnosisEvidence, exceptions: [...exceptions.values()] };
}

const esc = value => String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const paragraph = (value, style = "Normal", bullet = false) => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ""}</w:pPr><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p>`;
async function wordDocument(report, mapping, sourceName) {
  const count = report.observations.length, body = [];
  body.push(paragraph(`Patient Summary ${report.label}`, "Title"));
  body.push(paragraph(`Total net payment: ${money(report.total)}${report.known < count ? ` (${report.known ? "partial; " : ""}${count - report.known} amount${count - report.known === 1 ? "" : "s"} missing)` : ""}`));
  body.push(paragraph(`Primary diagnosis: ${report.diagnosis}`));
  body.push(paragraph("Significant services", "Heading1"));
  for (const group of report.included) body.push(paragraph(`${group.dos} — ${group.service} — Net payment ${money(group.known ? group.net : null)}${group.known && group.known < group.evidence.length ? " (partial)" : ""}${group.pending > PENDING_LIMIT ? `; pending ${money(group.pending)}` : ""}`, "Normal", true));
  if (!report.included.length) body.push(paragraph(!count ? "No financial observations recorded." : report.observations.every(row => row.net === null || abs(row.net) <= 20000n) ? `No events over $200${report.known < count ? " among recorded payments; some amounts are missing" : ""}.` : "No services meet the significance threshold."));
  body.push(paragraph("High pending balances", "Heading1"));
  if (!mapping.pending_cents || !report.pendingKnown || report.pendingKnown < count) body.push(paragraph(`Pending amounts ${report.pendingKnown ? "are incomplete" : "are not recorded"}; exposure cannot be fully assessed.`));
  if (report.pending > PENDING_LIMIT) body.push(paragraph(`Total recorded pending: ${money(report.pending)}${report.pendingKnown < count ? " (partial)" : ""}.`));
  const pendingGroups = [...report.included].filter(g => g.pending > PENDING_LIMIT);
  for (const group of pendingGroups) body.push(paragraph(`${group.dos} — ${group.service} — Pending ${money(group.pending)}${group.pendingKnown < group.evidence.length ? " (partial)" : ""}`, "Normal", true));
  for (const row of report.individualPending) {
    const group = pendingGroups.find(g => g.dos === row.dos && g.service === row.service);
    if (group?.evidence.length === 1) continue;
    body.push(paragraph(`${row.dos} — ${row.service} — Individual pending ${money(row.amount)} (source ${row.source.join(" / ")})`, "Normal", true));
  }
  if (report.pending !== null && report.pending <= PENDING_LIMIT && !pendingGroups.length && !report.individualPending.length) body.push(paragraph("No recorded pending amount exceeds $50,000."));
  body.push(paragraph("Source and limitations", "Heading1"));
  body.push(paragraph(`${sourceName} · ${mapping.table} · ${count} observation${count === 1 ? "" : "s"}. Patient key: ${report.key.join(" / ")}. Full source keys and code references are in evidence.json.`));
  if (report.omitted.length) body.push(paragraph(`Minor services are omitted; totals include all recorded payments. Paid-service bullets require an event over $200 and either ${mapping.significance_percent ?? 5}% of absolute payment activity or at least $50,000 in net payment magnitude.`));
  if (report.exceptions.length) body.push(paragraph(`${report.exceptions.length} code lookup exception${report.exceptions.length === 1 ? "" : "s"} (unknown code, missing service date, or reference/date limitations). Unverified descriptions were not used to infer a diagnosis.`));
  const zip = new JSZip(), xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  zip.file("[Content_Types].xml", xml + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  zip.file("_rels/.rels", xml + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", xml + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  zip.file("word/document.xml", xml + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  const base = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:color w:val="000000"/>';
  zip.file("word/styles.xml", xml + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${base}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:widowControl/></w:pPr><w:rPr>${base}<w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="240"/></w:pPr><w:rPr>${base}<w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr>${base}<w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`);
  zip.file("word/numbering.xml", xml + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>');
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
async function createSummaries(db, args, sourceName, sourceHash) {
  object(args, ["mapping"], ["mapping"]);
  const { patients, excluded } = collectPatients(db, args.mapping), files = [], evidence = [];
  let bytes = 0;
  for (const [index, patient] of patients.entries()) {
    const report = summarize(patient, args.mapping);
    const safeLabel = patient.label.normalize("NFKC").replace(/[^\p{L}\p{N}_ -]/gu, "_").slice(0, 70).trim() || "Patient";
    const name = `${String(index + 1).padStart(4, "0")} ${safeLabel}.docx`;
    const content = await wordDocument(report, args.mapping, sourceName);
    bytes += content.length;
    if (bytes > 64 * 1024 * 1024) throw new Error("Report set exceeds 64 MiB. Use a smaller database.");
    files.push({ name, bytes: content }); evidence.push({ file: name, ...report });
  }
  const manifest = JSON.stringify({ version: 1, source: sourceName, source_sha256: sourceHash, created_utc: new Date().toISOString(), mapping: args.mapping, excluded_rows: excluded, reports: evidence }, (_, v) => typeof v === "bigint" ? v.toString() : v);
  if (Buffer.byteLength(manifest) > 64 * 1024 * 1024) throw new Error("Report evidence exceeds 64 MiB. Use a smaller database.");
  files.push({ name: "evidence.json", bytes: Buffer.from(manifest) });
  return { files, patientCount: patients.length, diagnosisUnknown: evidence.filter(r => r.diagnosis.startsWith("Unknown")).length, missingPaymentCount: evidence.reduce((n, r) => n + r.observations.length - r.known, 0) };
}
module.exports = { collectPatients, summarize, createSummaries, wordDocument, money };
