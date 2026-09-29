"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { _electron: electron, expect } = require("@playwright/test");
const { spreadsheetFixture, pdfFixture } = require("./document-fixtures.cjs");

(async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "arma-document-smoke-"),
  );
  const workspace = path.join(temporary, "Local documents");
  await fs.mkdir(path.join(workspace, "unredacted"), { recursive: true });
  await fs.mkdir(path.join(workspace, "redacted"));
  const xlsx = await spreadsheetFixture(),
    pdf = pdfFixture();
  for (const directory of ["unredacted", "redacted"]) {
    await fs.writeFile(
      path.join(workspace, directory, "Styled workbook.xlsx"),
      xlsx,
    );
    await fs.writeFile(path.join(workspace, directory, "Report.pdf"), pdf);
  }
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
    page.on("console", (message) => {
      if (message.type() === "error")
        console.log("Renderer diagnostic:", message.text());
    });
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, workspace);
    await page.locator("#welcome-open").click();
    const open = async (relative) => {
      await page.locator(`.tree-row[data-path="${relative}"]`).click();
    };
    await open("unredacted/Styled workbook.xlsx");
    await expect(page.locator('.sheet-cell[data-cell="A1"]')).toHaveText(
      "Synthetic claims summary",
      { timeout: 20000 },
    );
    await expect(page.locator('.sheet-cell[data-cell="A1"]')).toHaveAttribute(
      "colspan",
      "3",
    );
    assert.equal(
      await page
        .locator('.sheet-cell[data-cell="A1"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(32, 56, 100)",
    );
    assert.equal(
      await page
        .locator('.sheet-cell[data-cell="A1"]')
        .evaluate((el) => getComputedStyle(el).fontWeight),
      "700",
    );
    await expect(page.locator('.sheet-cell[data-cell="B3"]')).toHaveText(
      "$1,234.50",
    );
    await expect(page.locator('.sheet-cell[data-cell="C3"]')).toHaveText(
      "Sep 23, 2026",
    );
    await expect(page.locator('.sheet-cell[data-cell="A5"]')).toHaveCount(0);
    await expect(page.locator('.sheet-cell[data-cell="D3"]')).toHaveCount(0);
    assert.equal(
      await page
        .locator('.sheet-cell[data-cell="C10"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(255, 255, 0)",
    );
    await page.locator("#expand-preview").click();
    await expect(page.locator(".conversation")).toBeHidden();
    await page.screenshot({ path: path.join(temporary, "spreadsheet.png") });
    await page.locator('.sheet-cell[data-cell="B4"]').click();
    await expect(page.getByLabel("Cell value or formula")).toHaveValue("=B3*2");
    await page.getByLabel("Go to cell").fill("A205");
    await page.getByLabel("Go to cell").press("Enter");
    await expect(page.locator('.sheet-cell[data-cell="A205"]')).toHaveText(
      "Final visible row",
    );
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.locator('.sheet-cell[data-cell="A1"]')).toHaveText(
      "<script>window.previewInjected = true</script>",
    );
    assert.equal(await page.evaluate(() => window.previewInjected), undefined);
    await expect(page.locator('.sheet-cell[data-cell="A2"]')).toHaveText(
      "#DIV/0!",
    );
    await expect(page.locator('.sheet-cell[data-cell="B2"]')).toHaveText(
      "FALSE",
    );
    await expect(page.locator('.sheet-cell[data-cell="C2"]')).toHaveText("0");
    await expect(
      page.getByRole("tab", { name: "Hidden sheet", exact: true }),
    ).toHaveCount(0);
    await page.getByLabel("Show hidden rows, columns and sheets").click();
    await expect(
      page.getByRole("tab", { name: "Hidden sheet (hidden)", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("tab", { name: "Claims summary", exact: true })
      .click();
    await expect(page.locator('.sheet-cell[data-cell="A5"]')).toHaveText(
      "Hidden row",
    );
    await page.getByLabel("Spreadsheet zoom").selectOption("1.5");
    assert.equal(
      await page.locator(".sheet-surface").evaluate((el) => el.style.zoom),
      "1.5",
    );

    await open("unredacted/Report.pdf");
    await expect(page.locator(".pdf-viewer")).toHaveAttribute(
      "data-rendered-page",
      "1",
      { timeout: 20000 },
    );
    await expect(page.locator(".pdf-page-count")).toHaveText("/ 2");
    await expect(page.locator(".textLayer")).toContainText(
      "Synthetic PDF report",
    );
    assert.equal(
      await page
        .locator(".pdf-stage")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
    );
    await page.screenshot({ path: path.join(temporary, "pdf.png") });
    await page.getByLabel("Next PDF page").click();
    await expect(page.locator(".pdf-viewer")).toHaveAttribute(
      "data-rendered-page",
      "2",
    );
    await expect(page.locator(".textLayer")).toContainText("Second PDF page");
    await page.getByLabel("PDF zoom").selectOption("1.5");
    await page.getByLabel("Rotate PDF page").click();
    await expect
      .poll(async () =>
        page
          .locator(".pdf-paper")
          .evaluate((el) => el.clientWidth > el.clientHeight),
      )
      .toBe(true);
    await open("redacted/Styled workbook.xlsx");
    await expect(page.locator('.sheet-cell[data-cell="A1"]')).toHaveText(
      "Synthetic claims summary",
    );
    await open("redacted/Report.pdf");
    await expect(page.locator(".pdf-viewer")).toHaveAttribute(
      "data-rendered-page",
      "1",
    );
    await page.locator("#close-preview").click();
    await expect(page.locator("#preview")).toBeHidden();
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    const hash = (data) =>
      crypto.createHash("sha256").update(data).digest("hex");
    assert.equal(
      hash(
        await fs.readFile(
          path.join(workspace, "unredacted", "Styled workbook.xlsx"),
        ),
      ),
      hash(xlsx),
    );
    assert.equal(
      hash(await fs.readFile(path.join(workspace, "unredacted", "Report.pdf"))),
      hash(pdf),
    );
    console.log(
      `Document viewer smoke passed. Synthetic screenshots: ${temporary}`,
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
