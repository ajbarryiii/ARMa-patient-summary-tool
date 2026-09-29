"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const initSqlJs = require("sql.js");
const JSZip = require("jszip");
const { _electron: electron, expect } = require("@playwright/test");
const { populate } = require("./patient-summary-fixture.cjs");

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "arma-summary-smoke-")), workspace = path.join(temporary, "Workspace");
  await fs.mkdir(path.join(workspace, "unredacted"), { recursive: true });
  await fs.mkdir(path.join(workspace, "redacted"));
  const SQL = await initSqlJs(), db = new SQL.Database(); populate(db);
  const bytes = Buffer.from(db.export()); db.close();
  const source = path.join(workspace, "redacted/patients.sqlite");
  await fs.writeFile(source, bytes);
  await fs.writeFile(path.join(workspace, "redacted/report.csv"), "patient,amount\nA,1\n");
  await fs.writeFile(path.join(workspace, "unredacted/private.sqlite"), bytes);
  const env = { ...process.env, ARM_USER_DATA: path.join(temporary, "app-data"), ARM_ENABLE_CODEX: "1" }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve(__dirname, "../main.cjs")], env });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ app, dialog }, root) => {
      const requireApp = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
      const { AgentBridge } = requireApp("./agents.cjs"), { mapping } = requireApp("./tests/patient-summary-fixture.cjs");
      global.__summarySmoke = { calls: [], results: [] };
      AgentBridge.prototype.status = async () => [{ id: "claude", name: "Claude Code", available: true, models: requireApp("./model-options.cjs").CLAUDE_MODELS }, { id: "codex", name: "Codex · testing", available: true, models: [{ id: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["medium"], defaultEffort: "medium" }] }];
      AgentBridge.prototype.start = async function(args, emit) {
        const runId = `summary-smoke-${Date.now()}`;
        if (args.access.tools.map(t => t.name).join() !== "report_sql,create_patient_summaries") throw new Error("Unexpected summary capabilities");
        global.__summarySmoke.calls.push({ provider: args.provider, prompt: args.prompt });
        this.runs.set(runId, { access: args.access });
        setTimeout(async () => {
          try {
            await args.access.call("report_sql", { sql: "SELECT COUNT(*) FROM patients" });
            const result = await args.access.call("create_patient_summaries", { mapping });
            global.__summarySmoke.results.push(result);
            emit({ runId, type: "delta", text: `Saved ${result.patientCount} patient summaries in ${result.path}` });
          } catch (error) { emit({ runId, type: "error", text: error.message }); }
          finally { args.access.cancel(); this.runs.delete(runId); emit({ runId, type: "done" }); }
        }, 30);
        return { runId };
      };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, workspace);
    await page.locator("#connections").click(); await page.locator("#refresh-connections").click(); await page.locator("#close-connections").click();
    await page.locator("#welcome-open").click();
    await page.locator("#patient-summaries-skill").click();
    await expect(page.locator("#prompt")).toHaveValue(/Word summary for each patient/);
    await expect(page.locator("#send")).toBeDisabled();
    for (const file of ["unredacted/private.sqlite", "redacted/report.csv"]) {
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(workspace, file));
      await page.locator("#redact-choose").click();
      await expect(page.locator("#toast")).toContainText(file.endsWith(".csv") ? "SQLite" : "not available");
      await expect(page.locator("#send")).toBeDisabled();
    }
    await page.locator("#prompt").fill("Use the reviewed mapping. @pat");
    await expect(page.getByRole("option", { name: "redacted/patients.sqlite", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: /report.csv|private/ })).toHaveCount(0);
    await page.getByRole("option", { name: "redacted/patients.sqlite", exact: true }).click();
    await page.locator("#model").selectOption("claude:");
    await expect(page.locator("#patient-summaries-skill")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#redaction-source")).toContainText("patients.sqlite");
    await page.locator("#model").selectOption("codex:gpt-6-sol");
    await expect(page.locator("#prompt")).toHaveValue(/reviewed mapping/);
    await expect(page.locator("#toast")).toBeHidden({ timeout: 12000 });
    await page.screenshot({ path: path.join(temporary, "summary-composer.png") });
    await page.locator("#send").click();
    await expect(page.locator("#messages")).toContainText("Saved 4 patient summaries", { timeout: 15000 });
    await expect(page.locator("#patient-summaries-skill")).toBeEnabled();
    const state = await app.evaluate(() => global.__summarySmoke), saved = state.results[0];
    assert.equal(state.calls[0].provider, "codex");
    const names = await fs.readdir(path.join(workspace, saved.path));
    assert.equal(names.filter(n => n.endsWith(".docx")).length, 4);
    const low = await JSZip.loadAsync(await fs.readFile(path.join(workspace, saved.path, "0002 PATIENT_B.docx")));
    assert.match(await low.file("word/document.xml").async("string"), /No events over \$200/);
    assert.deepEqual(await fs.readFile(source), bytes);
    await page.locator("#redact-skill").click();
    await expect(page.locator("#patient-summaries-skill")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#redaction-source")).toBeHidden();
    await page.screenshot({ path: path.join(temporary, "summary-saved.png") });
    assert.deepEqual(errors, []);
    console.log(`Patient summaries smoke passed. Synthetic reports and screenshots: ${temporary}\nReport set: ${path.join(workspace, saved.path)}`);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
