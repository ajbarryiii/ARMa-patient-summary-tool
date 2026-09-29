"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");
const { UnredactionService, runSavedUnredaction } = require("../unredaction.cjs");
const { PLAN, TOOL } = require("../unredaction-tools.cjs");
const { mappingsFromCSVs, restoreXML } = require("../unredaction-worker.cjs");
const { REFERENCE, REFERENCE_NAME } = require("../mapping-format.cjs");
const { WorkspaceTools } = require("../workspace-tools.cjs");
const { claudeArguments } = require("../agents.cjs");
const { startRedactionServer, remoteRequest } = require("../redaction-tools.cjs");
const { makeFixture, PRIVATE_NAME, PRIVATE_ID } = require("./unredaction-fixture.cjs");
const args = { schema_json: JSON.stringify(PLAN) };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arma-unredact-")), data = await makeFixture(root);
  const service = new UnredactionService(data.workspace);
  t.after(async () => { service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const selected = await service.select(data.folder), bound = await service.selectMappings(selected.id, [data.mapping]);
  return { ...data, root, service, bound };
}

test("a redaction mapping restores formatted Word copies, with count-only tool results and immutable sources", async t => {
  const f = await fixture(t), capability = f.service.capability(f.bound.id);
  const server = await startRedactionServer(f.root, null, capability); t.after(() => server.close());
  const result = await remoteRequest(server.endpoint, { name: TOOL.name, args });
  assert.deepEqual(Object.keys(result).sort(), ["documentCount", "path", "replacements", "status"]);
  assert.equal(result.status, "saved"); assert.equal(result.documentCount, 1); assert.equal(result.replacements, 2);
  assert.match(result.path, /^unredacted\/Patient Summaries\//);
  assert(!JSON.stringify({ context: capability.context, result }).includes(PRIVATE_NAME));
  assert(!JSON.stringify({ context: capability.context, result }).includes(PRIVATE_ID));
  const names = await fs.readdir(path.join(f.root, result.path)), name = names.find(n => n.endsWith(".docx"));
  assert.match(name, /Alex/);
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(f.root, result.path, name)));
  const sourceZip = await JSZip.loadAsync(f.bytes);
  const xml = await zip.file("word/document.xml").async("string"), doc = new DOMParser().parseFromString(xml, "application/xml");
  assert(doc.documentElement.textContent.includes(PRIVATE_NAME)); assert(doc.documentElement.textContent.includes(PRIVATE_ID));
  assert(!doc.documentElement.textContent.includes(f.name)); assert(!doc.documentElement.textContent.includes(f.id));
  for (const part of ["word/styles.xml", "word/numbering.xml"]) assert.equal(await zip.file(part).async("string"), await sourceZip.file(part).async("string"));
  assert.match(xml, /\$120,000.00/); assert.match(xml, /\$60,000.00/);
  assert.deepEqual(await fs.readFile(path.join(f.root, f.document)), f.bytes);
  assert.deepEqual(await fs.readFile(path.join(f.root, f.mapping)), f.csv);
  assert.deepEqual(await fs.readFile(path.join(f.root, result.path, "evidence.json")), await fs.readFile(path.join(f.root, f.folder, "evidence.json")));
  assert.match(await fs.readFile(path.join(f.root, result.path, "unredact.cjs"), "utf8"), /runSavedUnredaction/);
  await assert.rejects(capability.call(TOOL.name, args), /already run/);
  const again = await f.service.capability(f.bound.id).call(TOOL.name, args); assert.notEqual(again.path, result.path);
  const files = new WorkspaceTools(f.root);
  await assert.rejects(files.readFile(`${result.path}/restoration-audit.json`), /not available/);
  await assert.rejects(files.readFile(f.mapping), /not available/);
  await assert.rejects(capability.call("read_file", { path: f.mapping }), /Only/);
  const cli = claudeArguments(f.root, f.root, server.endpoint, false, capability);
  assert.equal(cli[cli.indexOf("--allowedTools") + 1], "mcp__workspace__run_unredaction_script");
  assert.match(cli[cli.indexOf("--mcp-config") + 1], /unredaction-tools.cjs/);
  assert.match(cli[cli.indexOf("--system-prompt") + 1], /name: unredact-summaries/);
});

test("mapping reference is installed for existing workspaces and operator edits stay intact", async t => {
  const f = await fixture(t), file = path.join(f.root, "unredacted", REFERENCE_NAME);
  assert.equal(await fs.readFile(file, "utf8"), REFERENCE);
  await fs.writeFile(file, "Operator notes\n"); await f.workspace.open(f.root);
  assert.equal(await fs.readFile(file, "utf8"), "Operator notes\n");
  await fs.unlink(file); await f.workspace.open(f.root);
  assert.equal(await fs.readFile(file, "utf8"), REFERENCE);
});

test("CSV quoting and simultaneous replacements preserve private text without cascades or substring matches", () => {
  const tokenA = "PERSON_0123456789ABCDEF", tokenB = "MEMBER_FEDCBA9876543210";
  const csv = `field,original,replacement,occurrences\r\n"name","A, ""B""\nC","${tokenA}","1"\r\n"id","${tokenA}","${tokenB}","1"\r\n`;
  const mapping = mappingsFromCSVs([Buffer.from(csv)]);
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${tokenA} ${tokenB} x${tokenA} ${tokenA}x</w:t></w:r></w:p></w:document>`;
  const result = restoreXML(xml, mapping);
  assert.equal(result.count, 2);
  const text = new DOMParser().parseFromString(result.xml, "application/xml").documentElement.textContent;
  assert.equal(text, `A, "B"\nC ${tokenA} x${tokenA} ${tokenA}x`);
  assert.throws(() => mappingsFromCSVs([Buffer.from(csv), Buffer.from(`field,original,replacement,occurrences\nname,Different,${tokenA},1\n`)]), /conflict/);
  assert.throws(() => mappingsFromCSVs([Buffer.from("wrong,headers\n")] ), /headers/);
});

test("unmapped tokens, malformed input and stale files never publish or echo originals", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "unredacted/incomplete.csv"), f.csv.toString().split("\r\n").slice(0, 2).join("\r\n") + "\r\n");
  const bound = await f.service.selectMappings(f.bound.id, ["unredacted/incomplete.csv"]);
  await assert.rejects(f.service.capability(bound.id).call(TOOL.name, args), /no selected mapping/);
  await assert.rejects(fs.stat(path.join(f.root, "unredacted/Patient Summaries")), { code: "ENOENT" });
  const capability = f.service.capability(f.bound.id);
  await assert.rejects(capability.call(TOOL.name, { schema_json: JSON.stringify({ ...PLAN, code: "require('fs')" }) }), /plan/);
  await fs.appendFile(path.join(f.root, f.mapping), "changed");
  await assert.rejects(capability.call(TOOL.name, args), /changed/);
  const cancelled = f.service.capability(f.bound.id); cancelled.cancel();
  await assert.rejects(cancelled.call(TOOL.name, args), /stopped/);
});

test("links, outside mappings, and in-flight cancellation cannot publish private output", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.selectMappings(f.bound.id, ["redacted/wrong.csv"]), /unredacted/);
  await fs.symlink(path.join(f.root, f.mapping), path.join(f.root, "unredacted/link.csv"));
  await assert.rejects(f.service.selectMappings(f.bound.id, ["unredacted/link.csv"]), /Symbolic/);
  await fs.link(path.join(f.root, f.mapping), path.join(f.root, "unredacted/hard.csv"));
  await assert.rejects(f.service.selectMappings(f.bound.id, ["unredacted/hard.csv"]), /linked/);
  await fs.unlink(path.join(f.root, "unredacted/hard.csv"));
  const renewed = await f.service.selectMappings(f.bound.id, [f.mapping]);
  const capability = f.service.capability(renewed.id), pending = assert.rejects(capability.call(TOOL.name, args), /stopped/);
  setImmediate(() => capability.cancel()); await pending;
  await assert.rejects(fs.stat(path.join(f.root, "unredacted/Patient Summaries")), { code: "ENOENT" });
  await fs.symlink(path.join(f.root, f.document), path.join(f.root, f.folder, "linked.docx"));
  await assert.rejects(f.service.select(f.folder), /Symbolic/);
});

test("saved restoration scripts bind original input digests and create new output sets", async t => {
  const f = await fixture(t), result = await f.service.capability(f.bound.id).call(TOOL.name, args);
  const script = await fs.readFile(path.join(f.root, result.path, "unredact.cjs"), "utf8");
  const config = JSON.parse(script.slice(script.indexOf("runSavedUnredaction({") + "runSavedUnredaction(".length, script.indexOf(").then(result")));
  const replay = await runSavedUnredaction(config); assert.notEqual(replay.path, result.path);
  await fs.appendFile(path.join(f.root, f.mapping), "\n");
  await assert.rejects(runSavedUnredaction(config), /inputs changed/);
});
