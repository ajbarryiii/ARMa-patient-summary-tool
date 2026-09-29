"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const { Workspace } = require("../workspace.cjs");
const { WorkspaceTools, handleRequest } = require("../workspace-tools.cjs");
const { RedactionService, workerFailure } = require("../redaction.cjs");
const { largeRedactionFixture } = require("./large-redaction-fixture.cjs");
const { redact, parseDelimited } = require("../redaction-worker.cjs");
const { validateSchema } = require("../redaction-schema.cjs");
const {
  createRedactionTools,
  startRedactionServer,
  remoteRun,
} = require("../redaction-tools.cjs");
const columnSchema = {
  version: 1,
  rules: [
    { field: "member_id", prefix: "MEMBER", scope: "column", column: "B" },
  ],
};
const textSchema = {
  version: 1,
  rules: [
    {
      field: "name",
      prefix: "PERSON",
      scope: "text",
      pattern: "(?:Employee|Member):[ \\t]*([^\\r\\n(]+?)[ \\t]*\\(",
      capture: 1,
    },
    {
      field: "id",
      prefix: "ID",
      scope: "text",
      pattern: "(?:Employee|Member):[^\\r\\n(]*\\(([^)\\r\\n]+)\\)",
      capture: 1,
    },
  ],
};
async function fixture(t) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "arma-redaction-unit-"),
  );
  const workspace = new Workspace();
  await workspace.open(temporary);
  const service = new RedactionService(workspace);
  t.after(async () => {
    service.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return {
    temporary,
    workspace,
    service,
    write: (name, bytes) =>
      fs.writeFile(path.join(temporary, "unredacted", name), bytes),
  };
}

test("a 29-sheet workbook with over a million cells, including styled blanks, runs within the existing worker memory limit", async (t) => {
  const f = await fixture(t),
    workbook = await largeRedactionFixture({ columns: 64, blankColumns: 24 });
  assert.equal(workbook.cells, 1224960);
  await f.write("large.xlsx", workbook.bytes);
  const selected = await f.service.select("unredacted/large.xlsx");
  const result = await f.service
    .capability(selected.id)
    .run(JSON.stringify(textSchema));
  assert.equal(result.items, workbook.rows * 2);
  const [job] = await f.service.jobs(),
    output = await fs.readFile(path.join(f.temporary, job.preview));
  const archive = await JSZip.loadAsync(output);
  assert.equal(
    await archive.file("xl/styles.xml").async("string"),
    workbook.styles,
  );
  const last = await archive.file("xl/worksheets/sheet29.xml").async("string");
  assert.doesNotMatch(last, /Synthetic Person|SYN001/);
  assert.match(last, /<v>-123\.45<\/v>/);
  assert.match(last, /ht="24"/);
  assert.match(last, /width="42"/);
  assert.match(last, /s="1"/);
  assert.match(last, /<c r="BL1220" s="1"\/>/);
  assert.deepEqual(
    await fs.readFile(path.join(f.temporary, "unredacted/large.xlsx")),
    workbook.bytes,
  );
  const mapping = parseDelimited(
    await fs.readFile(path.join(f.temporary, job.mapping), "utf8"),
    ",",
  );
  assert.equal(Number(mapping[1][3]), workbook.rows);
  assert.equal(Number(mapping[2][3]), workbook.rows);
});

test("worker errors distinguish exhausted memory, missing dependencies, and crashes without exposing exception data", () => {
  assert.match(
    workerFailure({
      code: "ERR_WORKER_OUT_OF_MEMORY",
      message: "PRIVATE-CANARY",
    }).message,
    /384 MiB memory/,
  );
  assert.match(
    workerFailure({ code: "MODULE_NOT_FOUND", message: "PRIVATE-CANARY" })
      .message,
    /dependency/,
  );
  const unexpected = workerFailure({ message: "PRIVATE-CANARY" }).message;
  assert.match(unexpected, /stopped unexpectedly/);
  assert.doesNotMatch(unexpected, /PRIVATE-CANARY|memory|resource limits/);
});
test("text captures replace only requested spans and reuse local mapping values", async () => {
  const bytes = Buffer.from(
    "Employee: Synthetic Person (SYN001)\nMember: Synthetic Person (SYN001)\nAmount: -123.45\n",
  );
  const result = await redact({ bytes, extension: ".txt", schema: textSchema });
  assert.equal(result.items, 4);
  const output = result.bytes.toString();
  assert.doesNotMatch(output, /Synthetic Person|SYN001/);
  assert.match(output, /Amount: -123.45/);
  const lines = output.split("\n");
  assert.equal(lines[0].slice(10), lines[1].slice(8));
  const mapping = parseDelimited(result.mapping, ",");
  assert.equal(mapping.length, 3);
  assert.equal(mapping[1][1], "Synthetic Person");
  assert.equal(mapping[1][3], "2");
});
test("XLSX redaction retains package styles and layout, removes unused private shared strings and formula caches", async () => {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("Claims");
  sheet.columns = [{ width: 24 }, { width: 30 }, { width: 20 }];
  sheet.addRow(["Service", "Member ID", "Amount"]);
  sheet.addRow(["Office visit", "PRIVATE-001", -123.45]);
  sheet.addRow(["Therapy", "PRIVATE-001", 55]);
  sheet.getCell("B2").font = { bold: true, color: { argb: "FF203864" } };
  sheet.getCell("B2").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFEE99" },
  };
  sheet.getCell("C2").numFmt = "$#,##0.00";
  sheet.getRow(2).height = 28;
  sheet.getCell("A5").value = { formula: "B2", result: "PRIVATE-001" };
  const bytes = Buffer.from(
    await book.xlsx.writeBuffer({ useSharedStrings: true }),
  );
  const result = await redact({
    bytes,
    extension: ".xlsx",
    schema: columnSchema,
  });
  assert.equal(result.items, 2);
  const originalZip = await JSZip.loadAsync(bytes),
    outputZip = await JSZip.loadAsync(result.bytes);
  assert.equal(
    await outputZip.file("xl/styles.xml").async("string"),
    await originalZip.file("xl/styles.xml").async("string"),
  );
  for (const entry of Object.values(outputZip.files))
    if (entry.name.endsWith(".xml"))
      assert.doesNotMatch(await entry.async("string"), /PRIVATE-001/);
  const copy = new ExcelJS.Workbook();
  await copy.xlsx.load(result.bytes);
  const out = copy.worksheets[0];
  assert.equal(out.getCell("B2").value, out.getCell("B3").value);
  assert.match(out.getCell("B2").value, /^MEMBER_[A-F0-9]{16}$/);
  const originalBook = new ExcelJS.Workbook();
  await originalBook.xlsx.load(bytes);
  assert.deepEqual(
    out.getCell("B2").style,
    originalBook.worksheets[0].getCell("B2").style,
  );
  assert.equal(out.getRow(2).height, 28);
  assert.equal(out.getColumn(2).width, 30);
  assert.equal(out.getCell("C2").value, -123.45);
  assert.equal(out.getCell("C2").numFmt, "$#,##0.00");
  assert.equal(out.getCell("A5").result, undefined);
});
test("CSV redaction preserves quoted multiline values, exact identifiers, BOM, and signed amounts", async () => {
  const source =
    '\uFEFFDescription,Member,Amount\r\n"Two, lines\nnext",000123,-001.20\r\n';
  const result = await redact({
    bytes: Buffer.from(source),
    extension: ".csv",
    schema: columnSchema,
  });
  assert.equal(result.items, 1);
  assert.equal(result.bytes.toString()[0], "\uFEFF");
  const rows = parseDelimited(result.bytes.toString().slice(1), ",");
  assert.equal(rows[1][0], "Two, lines\nnext");
  assert.equal(rows[1][2], "-001.20");
  assert.match(rows[1][1], /^MEMBER_/);
  assert.equal(parseDelimited(result.mapping, ",")[1][1], "000123");
});
test("shared-string compaction across sheets preserves rich text, Unicode, and escaped text", async () => {
  const book = new ExcelJS.Workbook();
  const rich = {
    richText: [
      { font: { bold: true }, text: "Keep & < > 🧾 " },
      { font: { italic: true }, text: "second line\nwith spaces  " },
    ],
  };
  for (const name of ["First", "Second"]) {
    const sheet = book.addWorksheet(name);
    sheet.getCell("B2").value = "PRIVATE & < > 🧾";
    sheet.getCell("A3").value = rich;
    sheet.getCell("B3").value = "PRIVATE & < > 🧾";
    sheet.getCell("C4").value = "  keep & < > 🧾\ntext  ";
    sheet.getCell("D5").font = { bold: true }; // A styled, self-closing blank cell.
  }
  const bytes = Buffer.from(
    await book.xlsx.writeBuffer({ useSharedStrings: true }),
  );
  const result = await redact({
    bytes,
    extension: ".xlsx",
    schema: columnSchema,
  });
  assert.equal(result.items, 4);
  const outputZip = await JSZip.loadAsync(result.bytes);
  const strings = await outputZip.file("xl/sharedStrings.xml").async("string");
  assert.doesNotMatch(strings, /PRIVATE/);
  assert.match(strings, /uniqueCount="2"/);
  assert.match(strings, /count="4"/);
  const copy = new ExcelJS.Workbook();
  await copy.xlsx.load(result.bytes);
  for (const sheet of copy.worksheets) {
    assert.deepEqual(sheet.getCell("A3").value, rich);
    assert.equal(sheet.getCell("C4").value, "  keep & < > 🧾\ntext  ");
    assert.equal(sheet.getCell("D5").value, null);
    assert.deepEqual(sheet.getCell("D5").font, { bold: true });
    assert.equal(
      sheet.getCell("B2").value,
      copy.worksheets[0].getCell("B3").value,
    );
  }
  assert.equal(parseDelimited(result.mapping, ",")[1][1], "PRIVATE & < > 🧾");
});
test("prefixed inline worksheet XML and an empty shared-string table remain valid", async () => {
  const { bytes } = await largeRedactionFixture({
    sheetCount: 1,
    rowCount: () => 1,
    columns: 2,
  });
  const zip = await JSZip.loadAsync(bytes);
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const worksheet = (await zip.file("xl/worksheets/sheet1.xml").async("string"))
    .replace(`xmlns="${main}"`, `xmlns:x="${main}"`)
    .replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g, "<$1x:$2")
    .replace(
      "Employee: Synthetic Person (SYN001)",
      "🧾 &amp; &lt; Employee: Synthetic Person (SYN001)&#13;\n",
    );
  zip.file("xl/worksheets/sheet1.xml", worksheet);
  zip.file(
    "xl/sharedStrings.xml",
    `<sst xmlns="${main}" count="0" uniqueCount="0"/>`,
  );
  const result = await redact({
    bytes: await zip.generateAsync({ type: "nodebuffer" }),
    extension: ".xlsx",
    schema: textSchema,
  });
  assert.equal(result.items, 2);
  const output = await JSZip.loadAsync(result.bytes);
  const sheet = await output.file("xl/worksheets/sheet1.xml").async("string");
  assert.doesNotMatch(sheet, /Synthetic Person|SYN001/);
  assert.match(
    sheet,
    /<x:t xml:space="preserve">🧾 &amp; &lt; Employee: PERSON_[A-F0-9]+ \(ID_[A-F0-9]+\)&#13;\n<\/x:t>/,
  );
  assert.match(sheet, /<x:c r="B1"><x:v>-123\.45<\/x:v><\/x:c>/);
  const { SaxesParser } = require("saxes");
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (error) => assert.fail(error.message));
  parser.write(sheet).close();
});
test("operator-bound capability returns only counts, keeps artifacts private, publishes only by local approval", async (t) => {
  const f = await fixture(t),
    original = "Employee: Synthetic Person (SYN001)";
  await f.write("source.txt", original);
  const selected = await f.service.select("unredacted/source.txt"),
    capability = f.service.capability(selected.id),
    tools = createRedactionTools(capability.run);
  const result = await tools.call("run_redaction_script", {
    schema_json: JSON.stringify(textSchema),
  });
  assert.deepEqual(result, {
    items: 2,
    file: "source.txt",
    status: "review_required",
  });
  assert.doesNotMatch(JSON.stringify(result), /Synthetic Person|SYN001/);
  await assert.rejects(
    capability.run(JSON.stringify(textSchema)),
    /already run/,
  );
  const jobs = await f.service.jobs();
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  const agent = new WorkspaceTools(f.temporary);
  await agent.ready;
  for (const artifact of [job.preview, job.mapping, job.script, job.schema])
    await assert.rejects(agent.readFile(artifact), /not available/);
  assert.deepEqual(await fs.readdir(path.join(f.temporary, "redacted")), []);
  const published = await f.service.approve(job.id);
  assert.equal(published.status, "published");
  assert.doesNotMatch(
    (await agent.readFile(published.output)).content,
    /Synthetic Person|SYN001/,
  );
  assert.equal(
    await fs.readFile(path.join(f.temporary, selected.path), "utf8"),
    original,
  );
  assert.equal(
    (await new RedactionService(f.workspace).jobs())[0].status,
    "published",
  );
});
test("generated script can be rerun locally without publishing or disclosing matched values", async (t) => {
  const f = await fixture(t);
  await f.write("source.txt", "Member: Synthetic Person (SYN001)");
  const source = await f.service.select("unredacted/source.txt");
  await f.service.capability(source.id).run(JSON.stringify(textSchema));
  const [job] = await f.service.jobs();
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    path.join(f.temporary, job.script),
  ]);
  assert.equal(stdout, "2 items redacted from source.txt\n");
  assert.equal(stderr, "");
  assert.equal((await f.service.jobs()).length, 2);
  assert.deepEqual(await fs.readdir(path.join(f.temporary, "redacted")), []);
});
test("source, preview, mapping, schema, and script edits invalidate publication", async (t) => {
  for (const target of ["source", "preview", "mapping", "schema", "script"]) {
    const f = await fixture(t);
    await f.write("source.txt", "Employee: Synthetic Person (SYN001)");
    const source = await f.service.select("unredacted/source.txt");
    await f.service.capability(source.id).run(JSON.stringify(textSchema));
    const [job] = await f.service.jobs();
    await fs.appendFile(path.join(f.temporary, job[target]), "changed");
    await assert.rejects(f.service.approve(job.id), /changed/);
    assert.deepEqual(await fs.readdir(path.join(f.temporary, "redacted")), []);
  }
});
test("invalid schemas, overlapping rules, and arbitrary tool requests fail without exposing original values", async () => {
  for (const schema of [
    { ...textSchema, command: "cat file" },
    {
      version: 1,
      rules: [{ ...textSchema.rules[0], replacement: "function(){}" }],
    },
  ])
    assert.throws(() => validateSchema(JSON.stringify(schema)));
  await assert.rejects(
    redact({
      bytes: Buffer.from("private"),
      extension: ".txt",
      schema: {
        version: 1,
        rules: [0, 1].map(() => ({
          field: "name",
          prefix: "PERSON",
          scope: "text",
          pattern: ".+",
        })),
      },
    }),
    /overlap/,
  );
  const tools = createRedactionTools(() => assert.fail("unexpected execution"));
  await assert.rejects(
    tools.call("read_file", { path: "unredacted/source.txt" }),
    /Only run_redaction_script/,
  );
  await assert.rejects(
    tools.call("run_redaction_script", {
      schema_json: "{}",
      source: "other.txt",
    }),
    /Only run_redaction_script/,
  );
  const definitions = await handleRequest(tools, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.deepEqual(
    definitions.result.tools.map((tool) => tool.name),
    ["run_redaction_script"],
  );
});
test("changed selections, links, unsupported files, zero-match publication, and cancellation fail closed", async (t) => {
  const f = await fixture(t);
  await f.write("source.txt", "Employee: Synthetic Person (SYN001)");
  const selected = await f.service.select("unredacted/source.txt");
  await f.write("source.txt", "changed");
  await assert.rejects(
    f.service.capability(selected.id).run(JSON.stringify(textSchema)),
    /changed/,
  );
  await f.write("source.pdf", "not a PDF");
  await assert.rejects(f.service.select("unredacted/source.pdf"), /Use XLSX/);
  await fs.link(
    path.join(f.temporary, "unredacted/source.txt"),
    path.join(f.temporary, "unredacted/link.txt"),
  );
  await assert.rejects(
    f.service.select("unredacted/link.txt"),
    /without links/,
  );
  await fs.unlink(path.join(f.temporary, "unredacted/link.txt"));
  const next = await f.service.select("unredacted/source.txt"),
    capability = f.service.capability(next.id);
  const running = capability.run(JSON.stringify(textSchema));
  setTimeout(capability.cancel, 5);
  await assert.rejects(running, /cancelled/);
  const zero = await f.service
    .capability(next.id)
    .run(JSON.stringify(textSchema));
  assert.equal(zero.items, 0);
  const [job] = await f.service.jobs();
  await assert.rejects(f.service.approve(job.id), /Nothing was replaced/);
});
test("private Claude pipe forwards only the bound schema and sanitized result", async (t) => {
  const f = await fixture(t);
  await f.write("source.txt", "Employee: Synthetic Person (SYN001)");
  const selected = await f.service.select("unredacted/source.txt");
  const cap = f.service.capability(selected.id);
  const server = await startRedactionServer(f.temporary, cap.run);
  t.after(() => server.close());
  const result = await remoteRun(server.endpoint, JSON.stringify(textSchema));
  assert.deepEqual(result, {
    items: 2,
    file: "source.txt",
    status: "review_required",
  });
});
