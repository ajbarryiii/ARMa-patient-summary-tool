"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const JSZip = require("jszip");
const { _electron: electron, expect } = require("@playwright/test");
const { makeFixture, PRIVATE_NAME, PRIVATE_ID } = require("./unredaction-fixture.cjs");
const { REFERENCE_NAME } = require("../mapping-format.cjs");

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "arma-unredact-smoke-")), root = path.join(temporary, "Workspace");
  await fs.mkdir(root); const fixture = await makeFixture(root);
  const env = { ...process.env, ARM_USER_DATA: path.join(temporary, "app-data"), ARM_ENABLE_CODEX: "1" }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve(__dirname, "../main.cjs")], env });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ app, dialog }, root) => {
      const requireApp = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
      const { AgentBridge } = requireApp("./agents.cjs"), { PLAN, TOOL } = requireApp("./unredaction-tools.cjs");
      global.__unredactSmoke = { calls: [], results: [] };
      AgentBridge.prototype.status = async () => [{ id: "claude", name: "Claude Code", available: true, models: requireApp("./model-options.cjs").CLAUDE_MODELS }, { id: "codex", name: "Codex · testing", available: true, models: [{ id: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["medium"], defaultEffort: "medium" }] }];
      AgentBridge.prototype.start = async function(args, emit) {
        const runId = `restore-smoke-${Date.now()}`;
        if (args.access.tools.map(t => t.name).join() !== TOOL.name) throw new Error("Unexpected restoration tools");
        global.__unredactSmoke.calls.push({ provider: args.provider, context: args.access.context, prompt: args.prompt });
        this.runs.set(runId, { access: args.access });
        setTimeout(async () => {
          try {
            const result = await args.access.call(TOOL.name, { schema_json: JSON.stringify(PLAN) });
            global.__unredactSmoke.results.push(result);
            emit({ runId, type: "delta", text: `Restored ${result.documentCount} patient summaries in ${result.path}` });
          } catch (error) { emit({ runId, type: "error", text: error.message }); }
          finally { args.access.cancel(); this.runs.delete(runId); emit({ runId, type: "done" }); }
        }, 30);
        return { runId };
      };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    await page.locator("#connections").click(); await page.locator("#refresh-connections").click(); await page.locator("#close-connections").click();
    await page.locator("#welcome-open").click(); await page.locator("#unredact-skill").click();
    await expect(page.locator("#unredact-skill")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#prompt")).toHaveValue(/local tool to unredact/);
    await expect(page.locator("#send")).toBeDisabled(); await expect(page.locator("#unredact-mappings")).toBeDisabled();
    await page.locator("#prompt").fill("Restore the selected summaries. @syn");
    await page.getByRole("option", { name: fixture.folder, exact: true }).click();
    await expect(page.locator("#send")).toBeDisabled(); await expect(page.locator("#unredact-mappings")).toBeEnabled();
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await page.locator("#unredact-mappings").click(); await expect(page.locator("#send")).toBeDisabled();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(root, fixture.mapping));
    await page.locator("#unredact-mappings").click(); await expect(page.locator("#redaction-source")).toContainText("1 mapping");
    await page.locator("#model").selectOption("claude:"); await page.locator("#model").selectOption("codex:gpt-6-sol");
    await expect(page.locator("#unredact-skill")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#redaction-source")).toContainText("1 mapping");
    await page.screenshot({ path: path.join(temporary, "unredact-composer.png") });
    await page.locator("#send").click();
    await expect(page.locator("#messages")).toContainText("Restored 1 patient summaries", { timeout: 15000 });
    await expect(page.locator("#unredact-skill")).toBeEnabled();
    const state = await app.evaluate(() => global.__unredactSmoke);
    assert.equal(state.calls[0].provider, "codex");
    assert(!JSON.stringify(state).includes(PRIVATE_NAME)); assert(!JSON.stringify(state).includes(PRIVATE_ID));
    const result = state.results[0], folder = path.join(root, result.path);
    const document = (await fs.readdir(folder)).find(n => n.endsWith(".docx"));
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(folder, document)));
    assert.match(await zip.file("word/document.xml").async("string"), /Alex/);
    assert.deepEqual(await fs.readFile(path.join(root, fixture.document)), fixture.bytes);
    assert.deepEqual(await fs.readFile(path.join(root, fixture.mapping)), fixture.csv);
    assert.match(await fs.readFile(path.join(root, "unredacted", REFERENCE_NAME), "utf8"), /field,original,replacement,occurrences/);
    await expect(page.locator("#messages")).not.toContainText(PRIVATE_NAME);
    await page.locator("#redact-skill").click();
    await expect(page.locator("#unredact-skill")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#unredact-mappings")).toBeHidden(); assert.deepEqual(errors, []);
    console.log(`Unredact summaries smoke passed. Synthetic screenshots: ${temporary}\nRestored report: ${path.join(folder, document)}`);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
