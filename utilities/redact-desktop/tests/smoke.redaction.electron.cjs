"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const ExcelJS = require("exceljs");
const { largeRedactionFixture } = require("./large-redaction-fixture.cjs");
const { _electron: electron, expect } = require("@playwright/test");

(async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "arma-redaction-smoke-"),
  );
  const workspace = path.join(temporary, "Redaction workspace");
  await fs.mkdir(path.join(workspace, "unredacted"), { recursive: true });
  await fs.mkdir(path.join(workspace, "redacted"));
  const sourceText =
    "Employee: Synthetic Person (SYN123)\nMember: Synthetic Person (SYN123)\nAmount: -123.45\n";
  const source = path.join(temporary, "Example.txt");
  await fs.writeFile(source, sourceText);
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("Members");
  sheet.columns = [{ width: 26 }, { width: 32 }, { width: 18 }];
  sheet.addRow(["Service", "Member ID", "Amount"]);
  sheet.addRow(["Consultation", "SECRET-MEMBER", 123.45]);
  sheet.getCell("B2").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFEE99" },
  };
  sheet.getCell("C2").numFmt = "$#,##0.00";
  const xlsx = Buffer.from(
    await book.xlsx.writeBuffer({ useSharedStrings: true }),
  );
  await fs.writeFile(path.join(workspace, "unredacted/Workbook.xlsx"), xlsx);
  const large = await largeRedactionFixture({ columns: 64, blankColumns: 24 });
  await fs.writeFile(
    path.join(workspace, "unredacted/Large.xlsx"),
    large.bytes,
  );
  const env = {
    ...process.env,
    ARM_USER_DATA: path.join(temporary, "app-data"),
    ARM_ENABLE_CODEX: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [path.resolve(__dirname, "../main.cjs")],
    env,
  });
  try {
    const page = await app.firstWindow(),
      errors = [],
      requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    await app.evaluate(({ app, dialog }, root) => {
      const requireApp = process
        .getBuiltinModule("node:module")
        .createRequire(`${app.getAppPath()}/package.json`);
      const { AgentBridge } = requireApp("./agents.cjs");
      const { CLAUDE_MODELS } = requireApp("./model-options.cjs");
      global.__redactionSmoke = { calls: [], results: [] };
      AgentBridge.prototype.status = async () => [
        { id: "claude", name: "Claude Code", available: true, models: CLAUDE_MODELS },
      ];
      AgentBridge.prototype.start = async function (args, emit) {
        assertRedaction(args);
        const runId = "redaction-smoke-" + Date.now();
        this.runs.set(runId, { redaction: args.redaction });
        global.__redactionSmoke.calls.push({
          prompt: args.prompt,
          model: args.model,
          effort: args.effort,
          source: args.redaction.sourceName,
        });
        const schema =
          args.redaction.sourceName === "Workbook.xlsx"
            ? {
                version: 1,
                rules: [
                  {
                    field: "member",
                    prefix: "MEMBER",
                    scope: "column",
                    column: "B",
                  },
                ],
              }
            : {
                version: 1,
                rules: [
                  {
                    field: "name",
                    prefix: "PERSON",
                    scope: "text",
                    pattern:
                      "(?:Employee|Member):[ \\t]*([^\\r\\n(]+?)[ \\t]*\\(",
                    capture: 1,
                  },
                  {
                    field: "id",
                    prefix: "ID",
                    scope: "text",
                    pattern:
                      "(?:Employee|Member):[^\\r\\n(]*\\(([^)\\r\\n]+)\\)",
                    capture: 1,
                  },
                ],
              };
        setTimeout(async () => {
          try {
            const result = await args.redaction.run(JSON.stringify(schema));
            global.__redactionSmoke.results.push(result);
            emit({
              runId,
              type: "delta",
              text: `${result.items} items redacted from ${result.file}. Ready for local review.`,
            });
          } catch (error) {
            emit({ runId, type: "error", text: error.message });
          } finally {
            this.runs.delete(runId);
            emit({ runId, type: "done" });
          }
        }, 20);
        return { runId };
      };
      function assertRedaction(args) {
        if (!args.redaction || typeof args.redaction.run !== "function")
          throw new Error("Missing bound redaction capability");
      }
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      });
    }, workspace);
    await page.locator("#connections").click();
    await page.locator("#refresh-connections").click();
    await page.locator("#close-connections").click();
    await page.locator("#welcome-open").click();
    await page.getByLabel("Model", { exact: true }).selectOption("claude:sonnet");
    await page.getByLabel("Reasoning effort").selectOption("low");
    await page.locator("#redact-skill").click();
    await expect(page.locator("#redact-skill")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#prompt")).toHaveAttribute(
      "placeholder",
      /What should be redacted/,
    );
    await expect(page.locator("#send")).toBeDisabled();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [source],
      });
    }, source);
    await page.locator("#redact-choose").click();
    await expect(page.locator("#redaction-source")).toContainText(
      "Example.txt",
    );
    await page
      .locator("#prompt")
      .fill("Redact names and IDs in Employee and Member rows.");
    await page.screenshot({ path: path.join(temporary, "composer.png") });
    await page.locator("#send").click();
    await expect(page.locator("#messages")).toContainText(
      "4 items redacted from Example.txt",
      { timeout: 15000 },
    );
    const first = page
      .locator(".redaction-result")
      .filter({ hasText: "Example.txt" });
    await expect(
      first.getByRole("button", { name: "Move to Redacted" }),
    ).toBeEnabled();
    assert.deepEqual(await fs.readdir(path.join(workspace, "redacted")), []);
    await first.getByRole("button", { name: "Move to Redacted" }).click();
    await expect(first).toContainText("In Redacted");
    await first.getByRole("button", { name: "View copy" }).click();
    await expect(page.locator("#preview-content")).toContainText(
      "Employee: PERSON_",
    );
    await expect(page.locator("#preview-content")).not.toContainText("SYN123");
    await page.screenshot({ path: path.join(temporary, "review.png") });
    await first.getByRole("button", { name: "Mapping CSV" }).click();
    await expect(page.locator('.sheet-cell[data-cell="B2"]')).toHaveText(
      "Synthetic Person",
    );
    await expect(page.locator("#messages")).not.toContainText(
      "Synthetic Person",
    );
    await first.getByRole("button", { name: "Script", exact: true }).click();
    await expect(page.locator("#preview-content")).toContainText(
      "runSavedRedaction",
    );
    await page.locator("#close-preview").click();
    await page.locator("#prompt").fill("Redact column B from row 2. @Work");
    await expect(
      page.getByRole("option", { name: "unredacted/Workbook.xlsx" }),
    ).toBeVisible();
    await page.locator("#prompt").press("Enter");
    await expect(page.locator("#redaction-source")).toContainText(
      "Workbook.xlsx",
    );
    await expect(page.locator("#prompt")).toHaveValue(
      "Redact column B from row 2. ",
    );
    await page.locator("#send").click();
    await expect(page.locator("#messages")).toContainText(
      "1 items redacted from Workbook.xlsx",
      { timeout: 15000 },
    );
    const second = page
      .locator(".redaction-result")
      .filter({ hasText: "Workbook.xlsx" });
    await second.getByRole("button", { name: "Review copy" }).click();
    await expect(page.locator('.sheet-cell[data-cell="B2"]')).toHaveText(
      /^MEMBER_/,
    );
    await expect(page.locator('.sheet-cell[data-cell="C2"]')).toHaveText(
      "$123.45",
    );
    assert.equal(
      await page
        .locator('.sheet-cell[data-cell="B2"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(255, 238, 153)",
    );
    await second.getByRole("button", { name: "Move to Redacted" }).click();
    await expect(second).toContainText("In Redacted");
    await page.locator("#close-preview").click();
    await page
      .locator("#prompt")
      .fill("Redact names and IDs in Employee rows. @Large");
    await expect(
      page.getByRole("option", { name: "unredacted/Large.xlsx" }),
    ).toBeVisible();
    await page.locator("#prompt").press("Enter");
    await expect(page.locator("#redaction-source")).toContainText("Large.xlsx");
    await page.locator("#send").click();
    await expect(page.locator("#messages")).toContainText(
      `${large.rows * 2} items redacted from Large.xlsx`,
      { timeout: 30000 },
    );
    const third = page
      .locator(".redaction-result")
      .filter({ hasText: "Large.xlsx" });
    await third.getByRole("button", { name: "Review copy" }).click();
    await expect(page.locator('.sheet-cell[data-cell="A1"]')).toHaveText(
      /^Employee: PERSON_[A-F0-9]+ \(ID_[A-F0-9]+\)$/,
      { timeout: 30000 },
    );
    await expect(page.locator('.sheet-cell[data-cell="B1"]')).toHaveText(
      "-123.45",
    );
    await page.getByRole("tab", { name: "Sheet 29", exact: true }).click();
    await expect(
      page.getByRole("table", { name: "Sheet 29", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page.getByLabel("Go to cell").fill("BL1220");
    await page.getByLabel("Go to cell").press("Enter");
    await expect(page.locator('.sheet-cell[data-cell="BL1220"]')).toHaveText(
      "",
    );
    assert.equal(
      await page
        .locator('.sheet-cell[data-cell="BL1220"]')
        .evaluate((el) => getComputedStyle(el).fontWeight),
      "700",
    );
    await expect(
      third.getByRole("button", { name: "Move to Redacted" }),
    ).toBeEnabled();
    assert.deepEqual(
      await fs.readFile(path.join(workspace, "unredacted/Large.xlsx")),
      large.bytes,
    );
    const state = await app.evaluate(() => global.__redactionSmoke);
    assert(state.calls.every((call) => call.model === "sonnet" && call.effort === "low"));
    assert.doesNotMatch(
      JSON.stringify(state),
      /Synthetic Person|SYN001|SYN123|SECRET-MEMBER/,
    );
    assert.equal(await fs.readFile(source, "utf8"), sourceText);
    assert.deepEqual(
      await fs.readFile(path.join(workspace, "unredacted/Workbook.xlsx")),
      xlsx,
    );
    assert.equal(
      (await fs.readdir(path.join(workspace, "redacted"))).length,
      2,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    console.log(`Redaction smoke passed. Synthetic screenshots: ${temporary}`);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
