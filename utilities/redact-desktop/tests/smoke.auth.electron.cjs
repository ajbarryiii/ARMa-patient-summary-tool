"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");

(async () => {
  const project = path.resolve(__dirname, ".."), temporary = await fs.mkdtemp(path.join(os.tmpdir(), "arma-auth-smoke-"));
  const fixture = path.join(temporary, "claude-fixture.cjs"), launcher = path.join(temporary, "launch.cjs");
  await fs.writeFile(fixture, `
    const fs = require('node:fs'), path = require('node:path');
    const root = ${JSON.stringify(temporary)}, marker = path.join(root,'signed-in');
    if (process.argv.includes('status')) {
      const loggedIn = fs.existsSync(marker);
      console.log(JSON.stringify({loggedIn})); process.exit(loggedIn ? 0 : 1);
    }
    if (!process.argv.includes('login')) process.exit(2);
    if (fs.existsSync(path.join(root,'fail'))) { console.error('sensitive provider failure'); process.exit(1); }
    console.log('If the browser did not open, visit: https://claude.com/cai/oauth/authorize?state=synthetic-state&code_challenge=synthetic-challenge');
    require('node:readline').createInterface({input:process.stdin}).on('line', code => {
      if (code !== 'synthetic-code#synthetic-state') { console.error('Invalid code.'); return; }
      fs.writeFileSync(marker,'saved'); process.exit(0);
    });
  `);
  await fs.writeFile(launcher, `
    const {shell} = require('electron');
    global.__openedAuthPages = [];
    shell.openExternal = async url => { global.__openedAuthPages.push(new URL(url).origin); };
    const {AgentBridge} = require(${JSON.stringify(path.join(project,"agents.cjs"))});
    AgentBridge.prototype.detect = async function(provider) {
      return {id:provider,name:'Claude Code',available:true,version:'2.1.280',
        binary:{command:process.execPath,args:[${JSON.stringify(fixture)}],node:true}};
    };
    require(${JSON.stringify(path.join(project,"main.cjs"))});
  `);
  const env = { ...process.env, ARM_USER_DATA: path.join(temporary, "app-data"), ARM_ENABLE_CODEX: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [launcher], env });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const status = page.locator('[data-provider="claude"] .connection-state');
    await expect(page.locator("#connections-dialog")).toBeVisible();
    await expect(status).toHaveText("Not signed in");
    assert.equal(await page.locator(".connection code").count(), 0);
    await page.locator("#claude-sign-in").click();
    await expect(status).toHaveText("Finish sign-in in your browser");
    await page.locator("#claude-open-browser").click();
    assert.deepEqual(await app.evaluate(() => global.__openedAuthPages), ["https://claude.com"]);
    await page.locator("#close-connections").click();
    await page.locator("#connections").click();
    await expect(page.locator("#claude-cancel-sign-in")).toBeVisible();
    await page.locator("#claude-cancel-sign-in").click();
    await expect(status).toHaveText("Not signed in");
    await page.locator("#claude-sign-in").click();
    await page.locator(".connection-code summary").click();
    await page.locator("#claude-sign-in-code").fill("wrong#state");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.locator(".connection-error")).toContainText("full sign-in code");
    await page.locator(".connection-code summary").click();
    await page.locator("#claude-sign-in-code").fill("synthetic-code#synthetic-state");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(status).toHaveText("Signed in");
    await expect(page.locator("#claude-sign-in")).toHaveText("Sign in again");
    await expect(page.locator("#claude-sign-in-code")).toHaveCount(0);
    await page.screenshot({ path: path.join(temporary, "signed-in.png") });
    await fs.writeFile(path.join(temporary,"fail"), "true");
    await page.locator("#claude-sign-in").click();
    await expect(status).toHaveText("Sign-in needs attention");
    await expect(page.locator(".connection-error")).toContainText("did not finish");
    assert(!await page.locator("body").innerText().then(text => text.includes("sensitive provider failure")));
    await page.locator("#refresh-connections").click();
    await expect(status).toHaveText("Signed in");
    assert.deepEqual(errors, []);
    console.log(`In-app sign-in smoke passed: browser retry, cancellation, code entry, saved status, failure recovery. Screenshot: ${temporary}/signed-in.png`);
    console.log("Authentication is synthetic; no real account or browser session was used.");
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
