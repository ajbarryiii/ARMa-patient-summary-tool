"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const path = require("node:path");
const { createHash } = require("node:crypto");
const initSqlJs = require("sql.js");
const JSZip = require("jszip");
const { SaxesParser } = require("saxes");
const XLSX = require("xlsx");
const { validateZip } = require("./workbook-archive.cjs");

function xml(text, handlers) {
  const p = new SaxesParser({ xmlns: true });
  p.on("doctype", () => { throw new Error("XML declarations are unsupported."); });
  for (const [name, handler] of Object.entries(handlers)) p.on(name, handler);
  p.write(text).close();
}
const attr = (tag, name) => Object.values(tag.attributes).find(a => a.local === name)?.value;
function moneyCents(value) {
  if (value == null || !String(value).trim()) return null;
  let text = String(value).trim().replace(/[$,\s]/g, "");
  if (/^\(.*\)$/.test(text)) text = "-" + text.slice(1, -1);
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m || text.length > 100) throw new Error("Invalid monetary value.");
  const exponent = Number(m[4] || 0) + 2 - (m[3] || "").length;
  if (Math.abs(exponent) > 100) throw new Error("Monetary value out of range.");
  let integer = BigInt(m[2] + (m[3] || ""));
  if (exponent >= 0) integer *= 10n ** BigInt(exponent);
  else {
    const divisor = 10n ** BigInt(-exponent);
    if (integer % divisor) throw new Error("Nonzero fractional cents in source.");
    integer /= divisor;
  }
  if (m[1] === "-") integer = -integer;
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER))
    throw new Error("Monetary value exceeds exact integer range.");
  return Number(integer);
}
function excelDate(value, date1904) {
  if (value == null || !String(value).trim()) return null;
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465 || (!date1904 && serial === 60))
    throw new Error("Invalid Excel date.");
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, serial < 60 ? 31 : 30);
  return new Date(epoch + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
}

async function importSource(db, bytes, extension) {
  db.run("CREATE TABLE source_sheets(sheet TEXT PRIMARY KEY, position INTEGER, metadata_json TEXT); CREATE TABLE source_rows(sheet TEXT, row INTEGER, cells_json TEXT, types_json TEXT, PRIMARY KEY(sheet,row));");
  const rowInsert = db.prepare("INSERT INTO source_rows VALUES (?,?,?,?)");
  const sheetInsert = db.prepare("INSERT INTO source_sheets VALUES (?,?,?)");
  let rowCount = 0;
  const insertRow = (sheet, row, cells, types) => {
    if (!Object.keys(cells).length) return;
    if (++rowCount > 500000) throw new Error("Report exceeds 500,000 populated rows.");
    rowInsert.run([sheet, row, JSON.stringify(cells), JSON.stringify(types)]);
  };
  db.run("BEGIN");
  try {
    if (extension === ".xlsx") {
      await validateZip(bytes);
      const zip = await JSZip.loadAsync(bytes);
      const read = async name => {
        const file = zip.file(name);
        if (!file) throw new Error("Missing workbook part.");
        return file.async("string");
      };
      const sheets = [], relations = {}, strings = [], formats = {}, styles = [];
      let date1904 = false, inStyles = false;
      xml(await read("xl/workbook.xml"), { opentag(t) {
        if (t.local === "sheet") sheets.push({ name: attr(t,"name"), id: attr(t,"id"), state: attr(t,"state") || "visible" });
        if (t.local === "workbookPr") date1904 = ["1","true"].includes(attr(t,"date1904"));
      }});
      if (!sheets.length || sheets.length > 64) throw new Error("Choose a workbook with 1–64 sheets.");
      xml(await read("xl/_rels/workbook.xml.rels"), { opentag(t) {
        if (t.local === "Relationship" && attr(t,"TargetMode") !== "External") relations[attr(t,"Id")] = attr(t,"Target");
      }});
      if (zip.file("xl/styles.xml")) xml(await read("xl/styles.xml"), {
        opentag(t) {
          if (t.local === "numFmt") formats[attr(t,"numFmtId")] = attr(t,"formatCode");
          if (t.local === "cellXfs") inStyles = true;
          if (t.local === "xf" && inStyles) styles.push(attr(t,"numFmtId"));
        }, closetag(t) { if (t.local === "cellXfs") inStyles = false; },
      });
      if (zip.file("xl/sharedStrings.xml")) {
        let text = "", inText = false;
        xml(await read("xl/sharedStrings.xml"), {
          opentag(t) { if (t.local === "si") text = ""; if (t.local === "t") inText = true; },
          text(t) { if (inText) text += t; },
          closetag(t) { if (t.local === "t") inText = false; if (t.local === "si") strings.push(text); },
        });
      }
      for (const [index, sheet] of sheets.entries()) {
        const target = relations[sheet.id];
        if (!target) throw new Error("Invalid worksheet relationship.");
        const file = path.posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
        if (!file.startsWith("xl/worksheets/")) throw new Error("Invalid worksheet path.");
        const merges = [];
        let row = 0, cells = {}, types = {}, cell, capture;
        xml(await read(file), {
          opentag(t) {
            if (t.local === "mergeCell") merges.push(attr(t,"ref"));
            if (t.local === "row") { row = Number(attr(t,"r")); cells = {}; types = {}; }
            if (t.local === "c") cell = { address: attr(t,"r"), type: attr(t,"t") || "n", style: attr(t,"s") || "0", value: null, formula: null };
            if (cell && ["v","t","f"].includes(t.local)) { capture = t.local; if (capture === "f") cell.formula = ""; else if (cell.value === null) cell.value = ""; }
          },
          text(text) { if (cell && capture) { if (capture === "f") cell.formula += text; else cell.value += text; } },
          closetag(t) {
            if (t.local === capture) capture = null;
            if (t.local === "c" && cell) {
              if (cell.value !== null || cell.formula !== null) {
                const match = /^([A-Z]+)(\d+)$/.exec(cell.address || "");
                if (!match || Number(match[2]) !== row) throw new Error("Invalid cell address.");
                const col = match[1];
                let value = cell.value;
                if (cell.type === "s") { value = strings[Number(value)]; if (value === undefined) throw new Error("Invalid shared string."); }
                cells[col] = value;
                types[col] = { type: cell.type, style: cell.style, ...(cell.formula !== null ? { formula: cell.formula } : {}) };
              }
              cell = null;
            }
            if (t.local === "row") insertRow(sheet.name, row, cells, types);
          },
        });
        sheetInsert.run([sheet.name, index + 1, JSON.stringify({ date1904, state: sheet.state, merges, styles, formats })]);
      }
    } else {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const book = XLSX.read(text, { type: "string", raw: true, FS: extension === ".tsv" ? "\t" : "," });
      const sheet = book.Sheets[book.SheetNames[0]], rows = new Map();
      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith("!")) continue;
        const match = /^([A-Z]+)(\d+)$/.exec(address);
        if (!match) continue;
        const rn = Number(match[2]);
        if (!rows.has(rn)) rows.set(rn, {});
        rows.get(rn)[match[1]] = cell.v == null ? null : String(cell.v);
      }
      sheetInsert.run(["Report",1,JSON.stringify({ format: extension, date1904: false })]);
      for (const [row,cells] of rows) insertRow("Report",row,cells,{});
    }
    db.run("COMMIT");
  } finally { rowInsert.free(); sheetInsert.free(); }
  return rowCount;
}

function runSQL(db, sql) {
  if (typeof sql !== "string" || !sql.trim() || sql.length > 200000) throw new Error("Provide SQL of at most 200,000 characters.");
  // No attached databases, extensions, pragma escape hatches or file operations.
  const tokens = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  if (/\b(attach|detach|pragma|vacuum|load_extension|readfile|writefile)\b/i.test(tokens)) throw new Error("Only local conversion SQL is available.");
  const result = [];
  let budget = 48000;
  for (const stmt of db.iterateStatements(sql)) {
    const columns = stmt.getColumnNames(), values = [];
    let count = 0, truncated = false;
    while (stmt.step()) {
      count++;
      if (count <= 100 && budget > 0) {
        const row = stmt.get().map(v => typeof v === "string" && v.length > 12000 ? (truncated = true, v.slice(0,12000) + "… [truncated]") : v);
        const size = JSON.stringify(row).length;
        if (size <= budget) { values.push(row); budget -= size; }
        else truncated = true;
      } else { truncated = true; break; }
    }
    if (columns.length) result.push({ columns, values, truncated });
    if (result.length > 30) throw new Error("Use fewer SQL result sets.");
  }
  return result;
}

async function start() {
  const SQL = await initSqlJs();
  const bytes = Buffer.from(workerData.bytes);
  const sqliteInput = [".sqlite",".db"].includes(workerData.extension);
  if(sqliteInput && bytes.subarray(0,16).toString() !== "SQLite format 3\0") throw new Error("Choose a valid SQLite database.");
  const db = sqliteInput ? new SQL.Database(bytes) : new SQL.Database();
  db.run("PRAGMA max_page_count=65536");
  require("./code-descriptions.cjs").register(db);
  db.create_function("money_cents", moneyCents);
  db.create_function("excel_date", excelDate);
  db.create_function("regexp_extract", (value, pattern, group) => {
    if (value == null) return null;
    if (typeof pattern !== "string" || pattern.length > 1000) throw new Error("Regex too long.");
    return new RegExp(pattern).exec(String(value))?.[Number(group || 0)] ?? null;
  });
  db.run("PRAGMA trusted_schema=OFF");
  const sourceRows = sqliteInput ? null : await importSource(db, bytes, workerData.extension);
  const parentProvenance = sqliteInput && db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='conversion_provenance'").length ? JSON.stringify(db.exec("SELECT * FROM conversion_provenance")) : null;
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const sourceDigest = () => sqliteInput ? null : createHash("sha256").update(JSON.stringify(db.exec("SELECT * FROM source_sheets ORDER BY position; SELECT * FROM source_rows ORDER BY sheet,row"))).digest("hex");
  const original = sourceDigest();
  if (workerData.readOnly) db.run("PRAGMA query_only=ON");
  parentPort.postMessage({ ready: true, sourceRows });
  parentPort.on("message", async ({ id, name, args }) => {
    try {
      if (name === "report_sql") return parentPort.postMessage({ id, result: runSQL(db,args.sql) });
      if (name === "create_patient_summaries" && workerData.readOnly && sqliteInput) {
        const result = await require("./patient-summaries.cjs").createSummaries(db, args, workerData.sourceName, sourceHash);
        return parentPort.postMessage({ id, result });
      }
      if (workerData.readOnly) throw new Error("Patient summaries use a read-only SQLite snapshot.");
      if (name !== "save_database" || !Array.isArray(args.tables) || !args.tables.length || args.tables.length > 32)
        throw new Error("Choose 1–32 output tables.");
      if (original !== sourceDigest()) throw new Error("Source tables were changed. Restart the conversion and preserve them.");
      const output = new SQL.Database(), tables = [];
      try {
        output.run("PRAGMA max_page_count=65536");
        for (const table of new Set(args.tables)) {
          if (typeof table !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(table) || /^(sqlite_|source_|conversion_provenance$|code_reference_provenance$)/i.test(table)) throw new Error("Invalid output table name.");
          const record = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[table]);
          if (!record.length || /\bVIRTUAL\b/i.test(record[0].values[0][0])) throw new Error("Save ordinary materialized tables only.");
          const cols = db.exec(`PRAGMA table_info("${table}")`)[0].values;
          if (!cols.length || cols.some(c => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(c[1]))) throw new Error("Use simple column identifiers.");
          runSQL(output,record[0].values[0][0]);
          output.run("BEGIN");
          const names = cols.map(c=>`"${c[1]}"`).join(",");
          const read = db.prepare(`SELECT ${names} FROM "${table}"`), write = output.prepare(`INSERT INTO "${table}" (${names}) VALUES (${cols.map(()=>"?").join(",")})`);
          let count = 0;
          try { while (read.step()) {
            const values = read.get();
            if (values.some(v => typeof v === "number" && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))))) throw new Error("An output number exceeds the exact supported range.");
            write.run(values); count++;
          } } finally { read.free(); write.free(); }
          output.run("COMMIT");
          const indexes = db.exec("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",[table]);
          for (const [sql] of indexes[0]?.values || []) runSQL(output,sql);
          tables.push({ table, rows: count });
        }
        output.run("CREATE TABLE conversion_provenance(source_filename TEXT, source_sha256 TEXT, source_rows INTEGER, created_utc TEXT, parent_provenance_json TEXT)");
        output.run("INSERT INTO conversion_provenance VALUES (?,?,?,?,?)",[workerData.sourceName,sourceHash,sourceRows,new Date().toISOString(),parentProvenance]);
        output.run("CREATE TABLE code_reference_provenance(manifest_json TEXT)");
        output.run("INSERT INTO code_reference_provenance VALUES (?)",[JSON.stringify(require("./code-descriptions.cjs").load().manifest)]);
        if (output.exec("PRAGMA foreign_key_check").length) throw new Error("Foreign key check failed. Include all referenced output tables and fix their links.");
        if (output.exec("PRAGMA integrity_check")[0].values[0][0] !== "ok") throw new Error("SQLite integrity check failed.");
        const data = output.export();
        if (data.length > 256*1024*1024) throw new Error("Database exceeds 256 MiB.");
        parentPort.postMessage({ id, result: { bytes: data, tables, sourceRows } });
      } finally { output.close(); }
    } catch (error) { parentPort.postMessage({ id, error: String(error.message).slice(0,1000) }); }
  });
}
if (parentPort) start().catch(error => parentPort.postMessage({ error: String(error.message).slice(0,1000) }));
module.exports = { moneyCents, excelDate, importSource, runSQL };
