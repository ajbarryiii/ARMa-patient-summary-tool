"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const initSqlJs = require("sql.js");
const { _electron: electron, expect } = require("@playwright/test");

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"arma-database-smoke-"));
  const workspace = path.join(temporary,"Workspace");
  await fs.mkdir(path.join(workspace,"unredacted"),{recursive:true});
  await fs.mkdir(path.join(workspace,"redacted"));
  const contents = "member,employer,amount\n000123,Group A,10.10\n000123,Group A,-2.00\n";
  const source = path.join(temporary,"Report.csv");
  await fs.writeFile(source,contents);
  await fs.writeFile(path.join(workspace,"unredacted/Private.csv"),"Private original");
  const env = {...process.env,ARM_USER_DATA:path.join(temporary,"app-data"),ARM_ENABLE_CODEX:"1"};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({args:[path.resolve(__dirname,"../main.cjs")],env});
  try {
    const page = await app.firstWindow(), errors = [];
    page.on("pageerror",error=>errors.push(error.message));
    await app.evaluate(({app,dialog},root) => {
      const requireApp = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
      const { AgentBridge } = requireApp("./agents.cjs");
      const { CLAUDE_MODELS } = requireApp("./model-options.cjs");
      global.__databaseSmoke = {calls:[],results:[]};
      AgentBridge.prototype.status = async () => [{id:"claude",name:"Claude Code",available:true,models:CLAUDE_MODELS},{id:"codex",name:"Codex · testing",available:true,models:[{id:"gpt-6-sol",name:"GPT-6-Sol",efforts:["medium"],defaultEffort:"medium"}]}];
      AgentBridge.prototype.start = async function(args,emit) {
        if (!args.access || args.redaction) throw new Error("Missing isolated database capability");
        const runId = `database-smoke-${Date.now()}`;
        this.runs.set(runId,{conversion:args.access});
        global.__databaseSmoke.calls.push({provider:args.provider,prompt:args.prompt,source:args.access.sourceName});
        const followup=global.__databaseSmoke.calls.length>1;
        setTimeout(async () => {
          try {
            if(followup) {
              const answer=await args.access.call("report_sql",{sql:"SELECT COUNT(*),SUM(amount_cents) FROM events"});
              if(JSON.stringify(answer[0].values)!==JSON.stringify([[2,810]])) throw new Error("Follow-up lost the saved database");
              emit({runId,type:"delta",text:"Follow-up: 2 events, total 810 cents."});
              return;
            }
            const inspected = await args.access.call("report_sql",{sql:"SELECT sheet,row,cells_json FROM source_rows ORDER BY row LIMIT 3"});
            if (inspected[0].values.length !== 3) throw new Error("Missing source inspection");
            await args.access.call("report_sql",{sql:"CREATE TABLE events AS SELECT sheet AS source_sheet,row AS source_row,json_extract(cells_json,'$.A') AS member,json_extract(cells_json,'$.B') AS employer_group,money_cents(json_extract(cells_json,'$.C')) AS amount_cents FROM source_rows WHERE row>1; SELECT SUM(amount_cents) FROM events;"});
            const result = await args.access.call("save_database",{tables:["events"]});
            global.__databaseSmoke.results.push(result);
            emit({runId,type:"delta",text:`Saved ${result.path}`});
          } catch (error) { emit({runId,type:"error",text:error.message}); }
          finally { args.access.cancel(); this.runs.delete(runId); emit({runId,type:"done"}); }
        },20);
        return {runId};
      };
      dialog.showOpenDialog = async () => ({canceled:false,filePaths:[root]});
    },workspace);
    await page.locator("#connections").click();
    await page.locator("#refresh-connections").click();
    await page.locator("#close-connections").click();
    await page.locator("#welcome-open").click();
    await page.locator("#database-skill").click();
    await expect(page.locator("#prompt")).toHaveAttribute("placeholder",/how the file is laid out.*database/);
    await expect(page.locator("#send")).toBeDisabled();
    await app.evaluate(({dialog},file) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[file]}); },path.join(workspace,"unredacted/Private.csv"));
    await page.locator("#redact-choose").click();
    await expect(page.locator("#toast")).toContainText("not available");
    assert.deepEqual(await fs.readdir(path.join(workspace,"redacted")),[]);
    await app.evaluate(({dialog},file) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[file]}); },source);
    await page.locator("#redact-choose").click();
    await expect(page.locator("#redaction-source")).toContainText("Report.csv");
    await page.locator("#prompt").fill("Each row is an event. A is member, B is employer, C is payment. Combine in events with amounts in cents.");
    // Changing providers used to silently drop the Database mode and selected source.
    await page.locator("#model").selectOption("codex:gpt-6-sol");
    await expect(page.locator("#database-skill")).toHaveAttribute("aria-pressed","true");
    await expect(page.locator("#redaction-source")).toContainText("Report.csv");
    await expect(page.locator("#prompt")).toHaveValue(/Each row is an event/);
    await page.locator("#model").selectOption("claude:");
    await expect(page.locator("#database-skill")).toHaveAttribute("aria-pressed","true");
    await page.locator("#model").selectOption("codex:gpt-6-sol");
    await page.screenshot({path:path.join(temporary,"database-composer.png")});
    await page.locator("#send").click();
    await expect(page.locator("#messages")).toContainText("Saved redacted/Report.",{timeout:15000});
    await expect(page.locator("#redaction-results")).toBeHidden();
    await expect(page.locator("#database-skill")).toBeEnabled();
    const state = await app.evaluate(()=>global.__databaseSmoke);
    assert.equal(state.calls[0].provider,"codex");
    const SQL = await initSqlJs(), db = new SQL.Database(await fs.readFile(path.join(workspace,state.results[0].path)));
    assert.deepEqual(db.exec("SELECT member,employer_group,amount_cents FROM events ORDER BY source_row")[0].values,[["000123","Group A",1010],["000123","Group A",-200]]);
    db.close();
    // Turn off the composer helper: normal chat must keep context and SQL access.
    await page.locator("#database-skill").click();
    await page.locator("#prompt").fill("How many events were saved and what is their total?");
    await page.locator("#send").click();
    await expect(page.locator("#messages")).toContainText("Follow-up: 2 events, total 810 cents.");
    await expect(page.locator("#database-skill")).toBeEnabled();
    await page.locator("#redact-skill").click();
    await expect(page.locator("#database-skill")).toHaveAttribute("aria-pressed","false");
    await expect(page.locator("#redaction-source")).toBeHidden();
    await page.locator("#database-skill").click();
    await page.locator("#prompt").fill("Same layout. @Rep");
    await expect(page.getByRole("option",{name:"redacted/Report.csv"})).toBeVisible();
    await expect(page.getByRole("option",{name:/Private/})).toHaveCount(0);
    await page.getByRole("option",{name:"redacted/Report.csv",exact:true}).click();
    await expect(page.locator("#redaction-source")).toContainText("Report.csv");
    await page.screenshot({path:path.join(temporary,"database-saved.png")});
    assert.equal(await fs.readFile(source,"utf8"),contents);
    assert.equal(await fs.readFile(path.join(workspace,"unredacted/Private.csv"),"utf8"),"Private original");
    assert.deepEqual(errors,[]);
    console.log(`Database smoke passed. Screenshots: ${temporary}`);
  } finally { await app.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
