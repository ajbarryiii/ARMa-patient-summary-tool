"use strict";
const JSZip = require("jszip");

// No private data or captured customer workbook is used by this regression.
// Highly compressed XML triggered a 384 MiB worker OOM in the former DOM parser.
async function largeRedactionFixture({
  sheetCount = 29,
  rowCount = (index) => 100 + index * 40,
  columns = 8,
  blankColumns = 0,
} = {}) {
  const zip = new JSZip(),
    sheets = [],
    relationships = [],
    contentTypes = [];
  let rows = 0;
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const relation =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  for (let i = 0; i < sheetCount; i++) {
    const count = rowCount(i);
    rows += count;
    const parts = [
      `<worksheet xmlns="${main}"><cols><col min="1" max="1" width="42" customWidth="1"/></cols><sheetData>`,
    ];
    for (let row = 1; row <= count; row++) {
      parts.push(`<row r="${row}" ht="24" customHeight="1">`);
      for (let column = 0; column < columns; column++) {
        let letter = "",
          n = column + 1;
        while (n) {
          n--;
          letter = String.fromCharCode(65 + (n % 26)) + letter;
          n = Math.floor(n / 26);
        }
        const address = letter + row;
        parts.push(
          column === 0
            ? `<c r="${address}" t="inlineStr" s="1"><is><t>Employee: Synthetic Person (SYN001)</t></is></c>`
            : column >= columns - blankColumns
              ? `<c r="${address}" s="1"/>`
              : `<c r="${address}"><v>-123.45</v></c>`,
        );
      }
      parts.push("</row>");
    }
    parts.push("</sheetData></worksheet>");
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, parts.join(""));
    sheets.push(
      `<sheet name="Sheet ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    );
    relationships.push(
      `<Relationship Id="rId${i + 1}" Type="${relation}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    );
    contentTypes.push(
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    );
  }
  const styles = `<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF203864"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
  zip.file("xl/styles.xml", styles);
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns="${main}" xmlns:r="${relation}"><sheets>${sheets.join("")}</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}<Relationship Id="styles" Type="${relation}/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="workbook" Type="${relation}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${contentTypes.join("")}</Types>`,
  );
  return {
    bytes: await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    }),
    rows,
    cells: rows * columns,
    styles,
  };
}
module.exports = { largeRedactionFixture };
