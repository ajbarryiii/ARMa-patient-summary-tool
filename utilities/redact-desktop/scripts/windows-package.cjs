"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Explicit application allowlist. Never copy the repository or a workspace.
const APPLICATION_FILES = [
  "main.cjs", "preload.cjs", "agents.cjs", "agent-tools.cjs", "claude-auth.cjs",
  "code-descriptions.cjs", "context-menus.cjs", "database.cjs",
  "database-tools.cjs", "database-worker.cjs", "document-preview.cjs",
  "mapping-format.cjs", "model-options.cjs", "notifications.cjs",
  "patient-summaries.cjs", "patient-summary-files.cjs", "patient-summary-tools.cjs",
  "redaction.cjs", "redaction-schema.cjs", "redaction-tools.cjs", "redaction-worker.cjs",
  "sessions.cjs", "skills.cjs", "spreadsheet-preview.cjs",
  "unredaction.cjs", "unredaction-tools.cjs", "unredaction-worker.cjs",
  "workbook-archive.cjs", "workspace.cjs", "workspace-tools.cjs",
  "xlsx-preview-sheet.cjs", "xlsx-redaction.cjs",
  "renderer/index.html", "renderer/app.js", "renderer/styles.css",
  "renderer/document-viewers.css", "renderer/document-viewers.mjs",
  "skills/redact/SKILL.md", "skills/database/SKILL.md",
  "skills/patient-summaries/SKILL.md", "skills/unredact-summaries/SKILL.md",
  "references/codes.json.gz", "references/manifest.json", "references/THIRD_PARTY_NOTICES.txt",
];
const CLAUDE_BINARY = "node_modules/@anthropic-ai/claude-code/bin/claude.exe";
const excludedParts = /^(?:tests?|__tests__|fixtures?|examples?|demos?|docs|coverage|benchmarks?|\.git|\.github|\.bin|unredacted|redacted)$/i;
function excluded(relative) {
  return relative.split("/").some(p => excludedParts.test(p) || p.startsWith(".")) ||
    /(?:\.map|\.d\.[cm]?ts|\.tsbuildinfo)$/i.test(relative) ||
    /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|CHANGELOG[^/]*|CHANGES[^/]*|codex-runtime\.cjs)$/i.test(relative);
}
async function walk(directory, relative = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Links cannot be shipped: ${name}`);
    if (entry.isDirectory()) files.push(...await walk(directory, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Special files cannot be shipped: ${name}`);
  }
  return files.sort();
}
async function prune(directory, relative = "") {
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || excluded(name)) await fs.rm(path.join(directory, name), { recursive: true, force: true });
    else if (entry.isDirectory()) await prune(directory, name);
  }
}
async function keepPackageFiles(stage, name, keep) {
  const directory = path.join(stage, "node_modules", name);
  for (const relative of await walk(directory)) {
    // Preserve licensing and attribution, including license-only READMEs.
    if (/^(?:LICENSE|LICENCE|COPYING|NOTICE|AUTHORS|README)(?:\.|$)/i.test(path.basename(relative))) continue;
    if (!keep.some(p => relative === p || (p.endsWith("/") && relative.startsWith(p))))
      await fs.unlink(path.join(directory, relative));
  }
}
async function peMachine(filename) {
  const handle = await fs.open(filename, "r");
  try {
    const header = Buffer.alloc(64);
    await handle.read(header, 0, 64, 0);
    if (header.toString("ascii", 0, 2) !== "MZ") throw new Error(`Not a Windows executable: ${filename}`);
    const pe = Buffer.alloc(6);
    await handle.read(pe, 0, 6, header.readUInt32LE(60));
    if (pe.toString("binary", 0, 4) !== "PE\0\0") throw new Error(`Invalid PE header: ${filename}`);
    return pe.readUInt16LE(4);
  } finally { await handle.close(); }
}
async function verifyNativeBinary(filename, { platform, arch }) {
  if (platform === "win32" && arch === "x64") {
    if (await peMachine(filename) !== 0x8664) throw new Error("Expected Windows x64 executable.");
    return;
  }
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch)) throw new Error("Unsupported package target.");
  const handle = await fs.open(filename, "r");
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const cpu = arch === "arm64" ? 0x100000c : 0x1000007;
    if (bytesRead !== 32 || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu)
      throw new Error(`Expected macOS ${arch} Mach-O executable: ${filename}`);
  } finally { await handle.close(); }
}
async function verifyApplication(directory, target = { platform: "win32", arch: "x64" }) {
  const files = await walk(directory);
  const allowed = new Set([...APPLICATION_FILES, "package.json", "LICENSE"]);
  for (const name of files) {
    if (excluded(name) || /(?:^|\/)node_modules\/(?:@openai|@playwright|playwright[^/]*|electron(?:-builder)?|app-builder[^/]*|@napi-rs)(?:\/|$)/.test(name))
      throw new Error(`Development/private file in package: ${name}`);
    if (!name.startsWith("node_modules/") && !allowed.has(name)) throw new Error(`Unapproved application file: ${name}`);
  }
  for (const name of [...allowed, CLAUDE_BINARY,
    "node_modules/sql.js/dist/sql-wasm.wasm", "node_modules/pdfjs-dist/build/pdf.mjs",
    "node_modules/pdfjs-dist/build/pdf.worker.mjs", "node_modules/xlsx/dist/cpexcel.js"])
    if (!files.includes(name)) throw new Error(`Missing runtime file: ${name}`);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  if (manifest.devDependencies || manifest.scripts) throw new Error("Development metadata in shipped manifest.");
  await verifyNativeBinary(path.join(directory, CLAUDE_BINARY), target);
  return Promise.all(files.map(async name => {
    const data = await fs.readFile(path.join(directory, name));
    return { path: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }));
}
module.exports = { APPLICATION_FILES, CLAUDE_BINARY, excluded, walk, prune, keepPackageFiles, peMachine, verifyNativeBinary, verifyApplication };
