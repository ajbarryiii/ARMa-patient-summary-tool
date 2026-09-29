"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const path = require("node:path");
const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const { validateZip } = require("./workbook-archive.cjs");
const { HEADERS } = require("./mapping-format.cjs");

class RestorationError extends Error {}
const fail = message => { throw new RestorationError(message); };
const WORD = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
const TOKEN = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]{0,19}_[A-F0-9]{16}(?![A-Za-z0-9_])/g;

function parseCSV(bytes) {
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("Mapping CSVs must use UTF-8 text."); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)) fail("A mapping CSV contains unsupported control characters.");
  const rows = [];
  let row = [], value = "", quoted = false, closed = false;
  const field = () => { row.push(value); value = ""; closed = false; };
  const end = () => { field(); rows.push(row); row = []; if (rows.length > 100001) fail("Use mappings with at most 100,000 rows."); };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (char === ",") field();
    else if (char === "\r" || char === "\n") { end(); if (char === "\r" && source[i + 1] === "\n") i++; }
    else if (char === '"' && !value && !closed) quoted = true;
    else if (closed || char === '"') fail("A mapping CSV has invalid quoting.");
    else value += char;
  }
  if (quoted) fail("A mapping CSV has an unfinished quoted value.");
  if (value || closed || row.length) end();
  return rows;
}
function mappingsFromCSVs(inputs) {
  const mapping = new Map();
  let count = 0;
  for (const bytes of inputs) {
    const [headers, ...rows] = parseCSV(bytes);
    if (!headers || headers.length !== HEADERS.length || new Set(headers).size !== HEADERS.length || HEADERS.some(name => !headers.includes(name))) fail("Mapping CSV headers must be field,original,replacement,occurrences.");
    for (const row of rows) {
      if (row.length !== headers.length) fail("A mapping CSV row does not match its headers.");
      const entry = Object.fromEntries(headers.map((name, i) => [name, row[i]]));
      if (!entry.field || !entry.original || !/^[A-Z][A-Z0-9_]{0,19}_[A-F0-9]{16}$/.test(entry.replacement) || !/^[1-9]\d{0,5}$/.test(entry.occurrences)) fail("A mapping row does not match the Redact CSV format.");
      if (++count > 100000) fail("Use at most 100,000 mapping rows per restoration.");
      if (mapping.has(entry.replacement) && mapping.get(entry.replacement) !== entry.original) fail("Selected mappings conflict for the same token. Choose the correct mappings for this report set.");
      mapping.set(entry.replacement, entry.original);
    }
  }
  if (!mapping.size) fail("The selected mapping CSVs have no replacements.");
  return mapping;
}
function replacements(text, mapping) {
  return [...text.matchAll(TOKEN)].map(match => {
    if (!mapping.has(match[0])) fail("Some summary tokens have no selected mapping. Select all matching mapping CSVs for this report set.");
    return { start: match.index, end: match.index + match[0].length, value: mapping.get(match[0]) };
  });
}
function replaceText(text, mapping) {
  const edits = replacements(text, mapping);
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}
function restoreXML(source, mapping) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail("The Word document contains unsupported XML declarations.");
  const document = new DOMParser({ onError: () => fail("A Word document contains invalid XML.") }).parseFromString(source, "application/xml");
  let count = 0;
  for (const paragraph of Array.from(document.getElementsByTagNameNS("*", "p")).filter(node => WORD.has(node.namespaceURI))) {
    let text = "", nodes = [];
    const walk = node => {
      if (node !== paragraph && WORD.has(node.namespaceURI) && node.localName === "p") return;
      if (WORD.has(node.namespaceURI) && node.localName === "t") {
        nodes.push({ node, start: text.length, end: text.length + node.textContent.length }); text += node.textContent;
      } else if (WORD.has(node.namespaceURI) && ["br", "tab", "cr"].includes(node.localName)) text += "\n";
      else for (const child of Array.from(node.childNodes || [])) walk(child);
    };
    walk(paragraph);
    const edits = replacements(text, mapping); count += edits.length;
    // Apply from the end so offsets into earlier runs remain valid. The original
    // text inherits the first token run's formatting; surrounding runs stay intact.
    for (const edit of edits.reverse()) {
      const parts = nodes.filter(part => part.end > edit.start && part.start < edit.end);
      if (!parts.length) continue;
      const first = parts[0], last = parts.at(-1);
      if (first === last) first.node.textContent = first.node.textContent.slice(0, edit.start - first.start) + edit.value + first.node.textContent.slice(edit.end - first.start);
      else {
        first.node.textContent = first.node.textContent.slice(0, edit.start - first.start) + edit.value;
        for (const part of parts.slice(1, -1)) part.node.textContent = "";
        last.node.textContent = last.node.textContent.slice(edit.end - last.start);
      }
      for (const part of parts) part.node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
    }
  }
  return { xml: count ? new XMLSerializer().serializeToString(document) : source, count };
}
async function restoreDocument(bytes, mapping) {
  await validateZip(Buffer.from(bytes));
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  if (!zip.file("word/document.xml")) fail("Choose valid Word patient summaries.");
  let count = 0;
  for (const file of Object.values(zip.files)) {
    if (file.dir || !/^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(file.name)) continue;
    const restored = restoreXML(await file.async("string"), mapping);
    if (restored.count) zip.file(file.name, restored.xml);
    count += restored.count;
  }
  return { bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), count };
}
async function restoreSummaries({ mappings, documents }) {
  const mapping = mappingsFromCSVs(mappings), files = [];
  let count = 0, size = 0;
  for (const [index, source] of documents.entries()) {
    const result = await restoreDocument(source.bytes, mapping);
    count += result.count; size += result.bytes.length;
    if (size > 64 * 1024 * 1024) fail("Restored reports exceed 64 MiB. Use a smaller report set.");
    const restoredName = replaceText(path.basename(source.name, ".docx"), mapping).normalize("NFKC").replace(/^\d{4} /, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
    let label = "";
    for (const char of restoredName) { if (Buffer.byteLength(label + char) > 180) break; label += char; }
    files.push({ name: `${String(index + 1).padStart(4, "0")} ${label || "Patient Summary"}.docx`, bytes: result.bytes });
  }
  if (!count) fail("No matching redaction tokens were found in the selected Word summaries.");
  return { files, replacements: count, documentCount: files.length };
}
if (parentPort) restoreSummaries(workerData).then(result => parentPort.postMessage({ result })).catch(error => {
  parentPort.postMessage({ error: error instanceof RestorationError ? error.message : "Local Word restoration failed. Check the documents and mappings locally." });
});
module.exports = { parseCSV, mappingsFromCSVs, restoreXML, restoreDocument, restoreSummaries };
