"use strict";
const ExcelJS = require("exceljs");

async function spreadsheetFixture() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Claims summary");
  sheet.columns = [
    { width: 26 },
    { width: 20 },
    { width: 19 },
    { width: 13, hidden: true },
  ];
  sheet.mergeCells("A1:C1");
  sheet.getCell("A1").value = "Synthetic claims summary";
  sheet.getCell("A1").font = {
    name: "Arial",
    size: 17,
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  sheet.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF203864" },
  };
  sheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 36;
  sheet.addRow(["Service", "Paid amount", "Service date"]);
  sheet.getRow(2).font = { bold: true, color: { argb: "FF203864" } };
  sheet.getRow(2).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFDCE6F1" },
  };
  sheet.getRow(2).height = 24;
  sheet.addRow(["Office visit", 1234.5, new Date("2026-09-23T00:00:00Z")]);
  sheet.getCell("B3").numFmt = "$#,##0.00";
  sheet.getCell("B3").border = {
    bottom: { style: "double", color: { argb: "FF203864" } },
  };
  sheet.getCell("C3").numFmt = "mmm d, yyyy";
  sheet.getCell("A4").value = {
    richText: [
      { text: "Rich ", font: { bold: true } },
      { text: "text", font: { italic: true, color: { argb: "FF008000" } } },
    ],
  };
  sheet.getCell("B4").value = { formula: "B3*2", result: 2469 };
  sheet.getCell("B4").numFmt = "$#,##0.00";
  sheet.getRow(5).hidden = true;
  sheet.getCell("A5").value = "Hidden row";
  sheet.getCell("D3").value = "Hidden column";
  sheet.getCell("A6").value = "Wrapped description on two lines";
  sheet.getCell("A6").alignment = { wrapText: true };
  sheet.getRow(6).height = 34;
  sheet.getCell("C10").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFF00" },
  };
  sheet.getCell("A205").value = "Final visible row";
  const detail = book.addWorksheet("Details");
  detail.addRow([
    "<script>window.previewInjected = true</script>",
    "Second sheet",
  ]);
  detail.getCell("A2").value = { formula: "1/0", result: { error: "#DIV/0!" } };
  detail.getCell("B2").value = { formula: "1=2", result: false };
  detail.getCell("C2").value = { formula: "SUM(A10:A12)", result: 0 };
  const hidden = book.addWorksheet("Hidden sheet", { state: "hidden" });
  hidden.addRow(["Local hidden content"]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function pdfFixture() {
  const stream1 =
    "0.12 0.22 0.39 rg 30 690 552 70 re f\nBT /F1 22 Tf 1 1 1 rg 50 718 Td (Synthetic PDF report) Tj ET\nBT /F1 14 Tf 0 0 0 rg 50 650 Td (Page one - local document preview) Tj ET\n";
  const stream2 =
    "BT /F1 24 Tf 0 0 0 rg 50 720 Td (Second PDF page) Tj ET\nBT /F1 14 Tf 50 675 Td (Page navigation is working.) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream1)} >>\nstream\n${stream1}endstream`,
    `<< /Length ${Buffer.byteLength(stream2)} >>\nstream\n${stream2}endstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
module.exports = { spreadsheetFixture, pdfFixture };
