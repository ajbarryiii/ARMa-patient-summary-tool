"use strict";
const path = require("node:path");
const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const elements = (node, name) =>
  Array.from(node.getElementsByTagNameNS("*", name));
function metadata(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error("Invalid workbook XML declarations.");
  return new DOMParser({
    onError: () => {
      throw new Error("Invalid workbook XML.");
    },
  }).parseFromString(text, "application/xml");
}

// Construct an in-memory, one-sheet preview package. Never save it over the
// source. ExcelJS retains its rich formatting support while avoiding objects
// for every other worksheet in the workbook. All sheet tabs remain available.
async function previewSheet(bytes, requestedIndex) {
  const zip = await JSZip.loadAsync(bytes);
  const workbook = metadata(await zip.file("xl/workbook.xml").async("string"));
  const nodes = elements(workbook, "sheet");
  if (!nodes.length || nodes.length > 64)
    throw new Error("Workbook previews require between 1 and 64 sheets.");
  const sheets = nodes.map((node) => ({
    name: node.getAttribute("name"),
    hidden:
      !!node.getAttribute("state") && node.getAttribute("state") !== "visible",
  }));
  const activeSheet =
    requestedIndex === -1
      ? Math.max(
          0,
          sheets.findIndex((sheet) => !sheet.hidden),
        )
      : requestedIndex;
  if (
    !Number.isInteger(activeSheet) ||
    activeSheet < 0 ||
    activeSheet >= sheets.length
  )
    throw new Error("Invalid worksheet selection.");
  const rels = metadata(
    await zip.file("xl/_rels/workbook.xml.rels").async("string"),
  );
  const rel = elements(rels, "Relationship").find(
    (item) =>
      item.getAttribute("Id") === nodes[activeSheet].getAttribute("r:id"),
  );
  if (!rel || rel.getAttribute("TargetMode") === "External")
    throw new Error("Invalid worksheet relationship.");
  const target = rel.getAttribute("Target");
  const filename = path.posix.normalize(
    target.startsWith("/") ? target.slice(1) : `xl/${target}`,
  );
  if (!filename.startsWith("xl/worksheets/") || !zip.file(filename))
    throw new Error("Invalid worksheet path.");
  const relationshipFile = `xl/worksheets/_rels/${path.posix.basename(filename)}.rels`;
  for (const entry of Object.keys(zip.files)) {
    if (
      entry.startsWith("xl/worksheets/") &&
      !zip.files[entry].dir &&
      entry !== filename &&
      entry !== relationshipFile
    )
      zip.remove(entry);
  }
  nodes.forEach((node, index) => {
    if (index !== activeSheet) node.parentNode.removeChild(node);
  });
  for (const name of elements(workbook, "definedName")) {
    if (!name.hasAttribute("localSheetId")) continue;
    if (Number(name.getAttribute("localSheetId")) === activeSheet)
      name.setAttribute("localSheetId", "0");
    else name.parentNode.removeChild(name);
  }
  zip.file("xl/workbook.xml", new XMLSerializer().serializeToString(workbook));
  return {
    bytes: await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    }),
    sheets,
    activeSheet,
  };
}
module.exports = { previewSheet };
