"use strict";
const path = require("node:path");
const JSZip = require("jszip");
const { SaxesParser } = require("saxes");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const { validateZip } = require("./workbook-archive.cjs");
const { RedactionError } = require("./redaction-schema.cjs");
const MAIN_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
]);
const elements = (element, name) =>
  Array.from(element.getElementsByTagNameNS("*", name));
const child = (element, name) =>
  Array.from(element.childNodes).find(
    (node) => node.nodeType === 1 && node.localName === name,
  );
const escapeText = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
const escapeAttribute = (text) =>
  escapeText(text)
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
function rejectDeclarations(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new RedactionError(
      "This workbook contains unsupported XML declarations.",
    );
}
// Only tiny workbook metadata documents use a DOM. Worksheet and shared-string
// XML is scanned incrementally: retaining a DOM for every sheet exhausted the
// worker heap even for ordinary, highly compressed workbooks.
function metadata(text) {
  rejectDeclarations(text);
  return new DOMParser({
    onError: () => {
      throw new Error("Invalid workbook XML");
    },
  }).parseFromString(text, "application/xml");
}
const serialize = (document) => new XMLSerializer().serializeToString(document);
function openTag(tag, updates = {}) {
  const attributes = Object.fromEntries(
    Object.values(tag.attributes).map((attribute) => [
      attribute.name,
      attribute.value,
    ]),
  );
  Object.assign(attributes, updates);
  return `<${tag.name}${Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`)
    .join("")}>`;
}
function patches(text) {
  const pieces = [];
  let cursor = 0;
  return {
    replace(start, end, value) {
      if (start < cursor || end < start)
        throw new Error("Overlapping XML edits");
      pieces.push(text.slice(cursor, start), value);
      cursor = end;
    },
    finish() {
      if (!pieces.length) return text;
      pieces.push(text.slice(cursor));
      return pieces.join("");
    },
  };
}
function scan(text, handlers) {
  rejectDeclarations(text);
  const parser = new SaxesParser({ xmlns: true }),
    stack = [];
  parser.on("error", () => {
    throw new Error("Invalid workbook XML");
  });
  parser.on("opentag", (tag) => {
    if (stack.length >= 128)
      throw new RedactionError("The workbook XML is nested too deeply.");
    stack.push(tag);
    handlers.open?.(
      tag,
      text.lastIndexOf("<", parser.position - 1),
      parser.position,
      stack,
    );
  });
  parser.on("closetag", (tag) => {
    handlers.close?.(
      tag,
      text.lastIndexOf("<", parser.position - 1),
      parser.position,
      stack,
    );
    stack.pop();
  });
  parser.on("text", (value) => handlers.text?.(value, stack));
  parser.on("cdata", (value) => handlers.text?.(value, stack));
  parser.write(text).close();
}
function readSharedStrings(text) {
  const entries = [];
  let entry, root;
  scan(text, {
    open(tag, start, end, stack) {
      if (stack.length === 1 && tag.local === "sst") root = { tag, start, end };
      if (
        MAIN_NAMESPACES.has(tag.uri) &&
        tag.local === "si" &&
        stack.length === 2
      )
        entry = { start, text: "" };
    },
    text(value, stack) {
      if (
        entry &&
        stack.at(-1).local === "t" &&
        !stack.some((tag) => tag.local === "rPh")
      )
        entry.text += value;
    },
    close(tag, start, end, stack) {
      if (entry && tag.local === "si" && stack.length === 2) {
        entry.end = end;
        entries.push(entry);
        entry = null;
      }
    },
  });
  if (!root || entry) throw new Error("Invalid shared strings");
  return { text, entries, root };
}
function scanCells(text, visit, readInline = true) {
  let cell;
  scan(text, {
    open(tag, start, end, stack) {
      if (!MAIN_NAMESPACES.has(tag.uri)) return;
      if (
        tag.local === "c" &&
        stack.at(-2)?.local === "row" &&
        stack.at(-3)?.local === "sheetData" &&
        MAIN_NAMESPACES.has(stack.at(-2)?.uri)
      ) {
        if (cell) throw new Error("Nested worksheet cells");
        cell = {
          tag,
          start,
          openEnd: end,
          depth: stack.length,
          sections: [],
          value: "",
          inline: "",
        };
      } else if (
        cell &&
        stack.length === cell.depth + 1 &&
        ["v", "f", "is"].includes(tag.local)
      ) {
        const section = {
          name: tag.local,
          start,
          openEnd: end,
          selfClosing: tag.isSelfClosing,
        };
        cell.sections.push(section);
        cell[tag.local] = section;
      }
    },
    text(value, stack) {
      if (!cell) return;
      if (
        cell.v &&
        stack.length === cell.depth + 1 &&
        stack.at(-1).local === "v" &&
        MAIN_NAMESPACES.has(stack.at(-1).uri)
      )
        cell.value += value;
      else if (
        readInline &&
        cell.is &&
        stack.at(-1).local === "t" &&
        MAIN_NAMESPACES.has(stack.at(-1).uri) &&
        !stack.some((tag) => tag.local === "rPh")
      )
        cell.inline += value;
    },
    close(tag, start, end, stack) {
      if (!cell) return;
      if (
        stack.length === cell.depth + 1 &&
        ["v", "f", "is"].includes(tag.local) &&
        cell[tag.local]
      )
        Object.assign(cell[tag.local], { closeStart: start, end });
      if (stack.length === cell.depth) {
        cell.closeStart = start;
        cell.end = end;
        visit(cell);
        cell = null;
      }
    },
  });
  if (cell) throw new Error("Incomplete worksheet cell");
}
function replaceCell(text, cell, value) {
  const edits = patches(text.slice(cell.openEnd, cell.closeStart));
  for (const section of cell.sections)
    edits.replace(section.start - cell.openEnd, section.end - cell.openEnd, "");
  const prefix = cell.tag.prefix ? `${cell.tag.prefix}:` : "";
  return (
    openTag(cell.tag, { t: "inlineStr" }) +
    edits.finish() +
    `<${prefix}is><${prefix}t xml:space="preserve">${escapeText(value)}</${prefix}t></${prefix}is>` +
    text.slice(cell.closeStart, cell.end)
  );
}
function rewriteSheet(text, name, strings, transform, used, budget) {
  const edits = patches(text);
  scanCells(text, (cell) => {
    // Cells are visited and discarded, not retained as workbook objects.
    // File/expanded-archive, worker heap and time limits bound this scan;
    // counting styled blanks imposed an unrelated workbook-size ceiling.
    const address = cell.tag.attributes.r?.value.match(/^([A-Z]+)(\d+)$/);
    if (!address) throw new Error("Invalid cell address");
    const type = cell.tag.attributes.t?.value;
    const index = type === "s" ? Number(cell.value) : null;
    if (
      type === "s" &&
      (!cell.v || !/^\d+$/.test(cell.value) || !strings[index])
    )
      throw new Error("Invalid shared string");
    const original =
      type === "s"
        ? strings[index].text
        : type === "inlineStr"
          ? cell.inline
          : cell.value;
    const replacement = transform.transform(original, {
      sheet: name,
      column: address[1],
      row: Number(address[2]),
    });
    if (replacement !== original)
      edits.replace(cell.start, cell.end, replaceCell(text, cell, replacement));
    else if (cell.f && cell.v) {
      // A formula's saved result can retain a replaced value. Keep the formula,
      // clear the cache, and let Excel recompute it on opening the copy.
      edits.replace(cell.v.start, cell.v.end, "");
    } else if (type === "s") {
      used.add(index);
      budget.references++;
    }
  });
  return edits.finish();
}
function compactSharedStrings(shared, used, referenceCount) {
  const remap = new Map(),
    edits = patches(shared.text);
  if (shared.root.tag.isSelfClosing) return { remap, text: shared.text };
  edits.replace(
    shared.root.start,
    shared.root.end,
    openTag(shared.root.tag, { count: referenceCount, uniqueCount: used.size }),
  );
  shared.entries.forEach((entry, index) => {
    if (used.has(index)) remap.set(index, remap.size);
    else edits.replace(entry.start, entry.end, "");
  });
  return { remap, text: edits.finish() };
}
function remapSheet(text, remap) {
  const edits = patches(text);
  scanCells(
    text,
    (cell) => {
      if (cell.tag.attributes.t?.value !== "s" || !cell.v) return;
      const previous = Number(cell.value),
        next = remap.get(previous);
      if (next === undefined)
        throw new Error("Invalid shared string reference");
      if (previous !== next)
        edits.replace(cell.v.openEnd, cell.v.closeStart, String(next));
    },
    false,
  );
  return edits.finish();
}

async function redactXlsx(bytes, transform, schema) {
  await validateZip(bytes);
  const zip = await JSZip.loadAsync(bytes);
  if (
    Object.keys(zip.files).some((name) =>
      /vbaProject|pivotCache|externalLinks\//i.test(name),
    )
  )
    throw new RedactionError(
      "Workbooks with macros, pivot caches, or external data links must be saved as a plain XLSX copy first.",
    );
  const workbook = metadata(await zip.file("xl/workbook.xml").async("string"));
  const relationships = metadata(
    await zip.file("xl/_rels/workbook.xml.rels").async("string"),
  );
  const sharedFile = zip.file("xl/sharedStrings.xml");
  let shared = sharedFile
    ? readSharedStrings(await sharedFile.async("string"))
    : null;
  const sheetNodes = elements(workbook, "sheet");
  if (sheetNodes.length > 64)
    throw new RedactionError("Redaction is limited to 64 sheets.");
  for (const rule of schema.rules)
    if (
      rule.sheet &&
      !sheetNodes.some((sheet) => sheet.getAttribute("name") === rule.sheet)
    )
      throw new RedactionError(
        "A specified worksheet does not exist. Check its name locally.",
      );
  const used = new Set(),
    filenames = [],
    budget = { references: 0 };
  for (const sheet of sheetNodes) {
    const relationship = elements(relationships, "Relationship").find(
      (item) => item.getAttribute("Id") === sheet.getAttribute("r:id"),
    );
    if (!relationship || relationship.getAttribute("TargetMode") === "External")
      throw new Error("Invalid worksheet");
    const target = relationship.getAttribute("Target");
    const filename = path.posix.normalize(
      target.startsWith("/") ? target.slice(1) : `xl/${target}`,
    );
    if (!filename.startsWith("xl/worksheets/") || !zip.file(filename))
      throw new Error("Invalid worksheet path");
    const result = rewriteSheet(
      await zip.file(filename).async("string"),
      sheet.getAttribute("name"),
      shared?.entries || [],
      transform,
      used,
      budget,
    );
    // Buffers keep completed worksheets off the V8 heap; no sheet DOMs survive
    // between iterations. Shared-string indexes are compacted in a second scan.
    zip.file(filename, Buffer.from(result));
    filenames.push(filename);
  }
  if (shared) {
    const compacted = compactSharedStrings(shared, used, budget.references);
    zip.file("xl/sharedStrings.xml", Buffer.from(compacted.text));
    shared = null;
    for (const filename of filenames)
      zip.file(
        filename,
        Buffer.from(
          remapSheet(await zip.file(filename).async("string"), compacted.remap),
        ),
      );
  }
  let calc = child(workbook.documentElement, "calcPr");
  if (!calc) {
    calc = workbook.createElementNS(
      workbook.documentElement.namespaceURI,
      "calcPr",
    );
    workbook.documentElement.appendChild(calc);
  }
  calc.setAttribute("fullCalcOnLoad", "1");
  calc.setAttribute("forceFullCalc", "1");
  zip.file("xl/workbook.xml", serialize(workbook));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
module.exports = { redactXlsx };
