"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");
const { spreadsheetFixture, pdfFixture } = require("./document-fixtures.cjs");
const { verifyApplication } = require("../scripts/windows-package.cjs");

// Exercises the actual pruned installer payload with the host's Electron.
// Windows installation, Claude auth and native execution still need Windows QA.
(async () => {
  const macBundle = process.env.ARM_TEST_MAC_BUNDLE;
  const packaged = macBundle ? path.join(macBundle, "Contents/Resources/app") : path.resolve(__dirname, "../dist/win-unpacked/resources/app");
  await verifyApplication(packaged, macBundle ? { platform: "darwin", arch: process.env.ARM_TEST_MAC_ARCH || "arm64" } : undefined);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "arma-package-smoke-"));
  // An isolated copy prevents Node from resolving a missing dependency from
  // the development checkout's ancestor node_modules directory.
  const payload = path.join(temporary, "Application");
  if (!macBundle) await fs.cp(packaged, payload, { recursive: true, mode: require("node:fs").constants.COPYFILE_FICLONE });
  const root = path.join(temporary, "Synthetic workspace");
  await fs.mkdir(path.join(root, "unredacted"), { recursive: true });
  await fs.writeFile(path.join(root, "unredacted/Preview.xlsx"), await spreadsheetFixture());
  await fs.writeFile(path.join(root, "unredacted/Preview.pdf"), pdfFixture());
  const env = { ...process.env, ARM_USER_DATA: path.join(temporary, "app-data"), ARM_ENABLE_CODEX: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const softwareRendering = process.argv.includes("--disable-gpu");
  const app = await electron.launch(macBundle ? {
    executablePath: path.join(macBundle, "Contents/MacOS/ARMa"), args: [], env,
  } : { args: [path.join(payload, "main.cjs"), ...(softwareRendering ? ["--disable-gpu"] : [])], env });
  try {
    const page = await app.firstWindow(), errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
    await page.locator("#welcome-open").click();
    await page.locator('.tree-row[data-path="unredacted/Preview.xlsx"]').click();
    await expect(page.locator('.sheet-cell[data-cell="A1"]')).toHaveText("Synthetic claims summary", { timeout: 20000 });
    await page.locator('.tree-row[data-path="unredacted/Preview.pdf"]').click();
    await expect(page.locator(".pdf-viewer")).toHaveAttribute("data-rendered-page", "1", { timeout: 20000 });
    await expect(page.locator(".textLayer")).toContainText("Synthetic PDF report");
    if (softwareRendering) {
      const gpu = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
      assert.equal(gpu.gpu_compositing, "disabled_software", JSON.stringify(gpu));
    }
    assert(!await page.locator('#model option').evaluateAll(options => options.some(option => option.value.startsWith("codex:"))));
    const result = await app.evaluate(async ({ app }, root) => {
      const requireApp = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
      const fs = requireApp("node:fs/promises"), path = requireApp("node:path"), assert = requireApp("node:assert/strict");
      const workspace = new (requireApp("./workspace.cjs").Workspace)(); await workspace.open(root);
      const redactions = new (requireApp("./redaction.cjs").RedactionService)(workspace);
      const databases = new (requireApp("./database.cjs").DatabaseService)(workspace);
      const restorations = new (requireApp("./unredaction.cjs").UnredactionService)(workspace);
      try {
        const original = "name,paid,pending\nAlex Example,1234.50,60000\nAlex Example,-34.50,0\n";
        await fs.writeFile(path.join(root, "unredacted/claims.csv"), original);
        const selected = await redactions.select("unredacted/claims.csv");
        const redacted = await redactions.capability(selected.id).run(JSON.stringify({ version: 1, rules: [{ field: "patient_name", prefix: "PERSON", scope: "column", column: "A" }] }));
        assert.equal(redacted.items, 2);
        const [job] = await redactions.jobs(); const published = await redactions.approve(job.id);
        const input = await databases.select(published.output), conversion = databases.capability(input.id);
        await conversion.call("report_sql", { sql: `CREATE TABLE events AS SELECT row AS line, json_extract(cells_json,'$.A') AS patient, money_cents(json_extract(cells_json,'$.B')) AS paid, money_cents(json_extract(cells_json,'$.C')) AS pending, '2026-06-01' AS dos, 'I10' AS icd FROM source_rows WHERE row>1` });
        const saved = await conversion.call("save_database", { tables: ["events"] });
        const report = await databases.select(saved.path);
        const summary = await databases.summaryAccess(report.id).call("create_patient_summaries", { mapping: {
          table: "events", patient_key: ["patient"], patient_label: "patient", observation_key: ["line"],
          net_payment_cents: "paid", pending_cents: "pending", dos: "dos", icd_code: "icd",
        } });
        assert.equal(summary.patientCount, 1);
        let restore = await restorations.select(summary.path);
        restore = await restorations.selectMappings(restore.id, [job.mapping]);
        const { TOOL, PLAN } = requireApp("./unredaction-tools.cjs");
        const restored = await restorations.capability(restore.id).call(TOOL.name, { schema_json: JSON.stringify(PLAN) });
        assert.equal(restored.documentCount, 1);
        const folder = path.join(root, restored.path), name = (await fs.readdir(folder)).find(name => name.endsWith(".docx"));
        const zip = await requireApp("jszip").loadAsync(await fs.readFile(path.join(folder, name)));
        const xml = await zip.file("word/document.xml").async("string");
        assert.match(xml, /Alex Example/); assert.match(xml, /1,200\.00/); assert.match(xml, /60,000\.00/);
        assert.equal(await fs.readFile(path.join(root, "unredacted/claims.csv"), "utf8"), original);
        await assert.rejects(databases.files.readFile(job.mapping), /not available/);
        assert.throws(() => requireApp.resolve("@openai/codex/package.json"), /Cannot find module/);
        return { patients: summary.patientCount, restored: restored.documentCount };
      } finally { redactions.dispose(); databases.dispose(); restorations.dispose(); }
    }, root);
    assert.deepEqual(result, { patients: 1, restored: 1 });
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    await page.screenshot({ path: path.join(temporary, "packaged-preview.png") });
    console.log(`Packaged payload smoke passed: XLSX/PDF viewers, real local workers, SQLite, summaries and restoration. Synthetic artifacts: ${temporary}`);
    console.log(macBundle ? "Native macOS app exercised; live authentication was not exercised." : "Windows installation, native Claude execution and live authentication were not exercised.");
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
