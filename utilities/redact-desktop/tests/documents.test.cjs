"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseWorkbook } = require("../spreadsheet-preview.cjs");
const { DocumentPreview } = require("../document-preview.cjs");
const { spreadsheetFixture } = require("./document-fixtures.cjs");
const XLSX = require("xlsx");

test("XLSX preview preserves saved formatting, dimensions, rich text and cached formula values", async () => {
  const workbook = await parseWorkbook(await spreadsheetFixture(), ".xlsx");
  const sheet = workbook.sheets[0];
  assert.equal(sheet.name, "Claims summary");
  assert.deepEqual(sheet.merges[0], { s: { c: 0, r: 0 }, e: { c: 2, r: 0 } });
  const title = workbook.styles[sheet.cells["1:1"].style];
  assert.equal(title.backgroundColor, "#203864");
  assert.equal(title.color, "#ffffff");
  assert.equal(title.fontWeight, "700");
  assert.equal(sheet.columns[1].width, 187);
  assert.equal(sheet.rows[1].height, 48);
  assert.equal(sheet.rows[5].hidden, true);
  assert.equal(sheet.columns[4].hidden, true);
  assert.equal(sheet.cells["3:2"].text, "$1,234.50");
  assert.equal(sheet.cells["3:3"].text, "Sep 23, 2026");
  assert.equal(sheet.cells["4:2"].text, "$2,469.00");
  assert.equal(sheet.cells["4:2"].formula, "B3*2");
  assert.equal(
    workbook.styles[sheet.cells["3:2"].style].borderBottom,
    "3px double #203864",
  );
  assert.equal(sheet.cells["4:1"].runs[0].css.fontWeight, "700");
  assert.equal(
    workbook.styles[sheet.cells["10:3"].style].backgroundColor,
    "#ffff00",
  );
  assert.equal(workbook.sheets[2].hidden, true);
  assert.equal(workbook.sheets[1].cells["2:1"].text, "#DIV/0!");
  assert.equal(workbook.sheets[1].cells["2:2"].text, "FALSE");
  assert.equal(workbook.sheets[1].cells["2:3"].text, "0");
});

test("CSV preview preserves identifiers, quoted delimiters, multiline cells and formula-looking text", async () => {
  const workbook = await parseWorkbook(
    Buffer.from(
      'ID,Description,Formula\n0012,"Line one, two\nLine three",=SUM(A1:A9)\n',
    ),
    ".csv",
  );
  const cells = workbook.sheets[0].cells;
  assert.equal(cells["2:1"].text, "0012");
  assert.equal(cells["2:2"].text, "Line one, two\nLine three");
  assert.equal(cells["2:3"].text, "=SUM(A1:A9)");
  assert.equal(cells["2:3"].formula, undefined);
});

test("legacy XLS opens with saved number formats and an explicit styling limitation", async () => {
  const workbook = XLSX.utils.book_new(),
    sheet = XLSX.utils.aoa_to_sheet([["Amount"], [1234.5]]);
  sheet.A2.z = "$#,##0.00";
  XLSX.utils.book_append_sheet(workbook, sheet, "Legacy");
  const result = await parseWorkbook(
    XLSX.write(workbook, { type: "buffer", bookType: "xls" }),
    ".xls",
  );
  assert.equal(result.sheets[0].cells["2:1"].text, "$1,234.50");
  assert.match(result.warnings[0], /Legacy XLS/);
});

test("worker parser is cancellable, caches unchanged revisions and rejects damaged files", async () => {
  const preview = new DocumentPreview();
  const file = {
    path: "unredacted/sample.xlsx",
    name: "sample.xlsx",
    revision: "1",
    kind: "spreadsheet",
    data: await spreadsheetFixture(),
  };
  const pending = preview.load(file);
  preview.cancel();
  await assert.rejects(pending, /cancelled/);
  const result = await preview.load(file);
  assert.equal(result.data, undefined);
  assert.equal(result.workbook.sheets.length, 3);
  assert.equal(result.workbook.lazySheets, true);
  assert.equal(result.workbook.activeSheet, 0);
  assert.equal(result.workbook.sheets[1].cells, undefined);
  assert.equal(await preview.load(file), result);
  const second = await preview.load(file, 1);
  assert.equal(second.workbook.activeSheet, 1);
  assert.equal(second.workbook.sheets[1].cells["2:3"].text, "0");
  assert.equal(second.workbook.sheets[0].cells, undefined);
  assert.equal(await preview.load(file, 1), second);
  const hidden = await preview.load(file, 2);
  assert.equal(hidden.workbook.activeSheet, 2);
  assert.equal(hidden.workbook.sheets[2].hidden, true);
  assert.equal(hidden.workbook.sheets[0].cells, undefined);
  assert.ok(hidden.workbook.sheets[2].cells["1:1"].text);
  for (const invalid of [-2, 64, "0", {}, 0.5])
    await assert.rejects(preview.load(file, invalid), /Invalid worksheet/);
  await assert.rejects(preview.load(file, 3), /worksheet|opened/);
  await assert.rejects(
    preview.load({
      ...file,
      revision: "2",
      data: Buffer.from("not a workbook"),
    }),
    /damaged|encrypted/,
  );
  preview.clear();
});
