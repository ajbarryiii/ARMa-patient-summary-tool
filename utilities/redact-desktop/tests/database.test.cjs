"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const initSqlJs = require("sql.js");
const { Workspace } = require("../workspace.cjs");
const { DatabaseService } = require("../database.cjs");
const { moneyCents, excelDate } = require("../database-worker.cjs");
const { createDatabaseTools } = require("../database-tools.cjs");
const { startRedactionServer, remoteRequest } = require("../redaction-tools.cjs");
const { claudeArguments } = require("../agents.cjs");

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"arma-database-"));
  const workspace = new Workspace();
  await workspace.open(temporary);
  const service = new DatabaseService(workspace);
  t.after(async () => { service.dispose(); await fs.rm(temporary,{recursive:true,force:true}); });
  return { temporary, workspace, service };
}
const flatSQL = `CREATE TABLE events AS SELECT sheet AS source_sheet,row AS source_row,json_extract(cells_json,'$.A') AS member,json_extract(cells_json,'$.B') AS employer_group,money_cents(json_extract(cells_json,'$.C')) AS amount_cents FROM source_rows WHERE row>1; SELECT COUNT(*),SUM(amount_cents) FROM events;`;

test("money and dates retain exact cents, signs, nulls and Excel date systems", () => {
  for (const [source, expected] of [["0.1900",19],["-123.45",-12345],["($1,000.00)",-100000],["1.25e2",12500],["",null],[null,null],["0",0]]) assert.equal(moneyCents(source),expected);
  assert.throws(()=>moneyCents("1.001"),/fractional/);
  assert.throws(()=>moneyCents("900719925474099.12"),/range/);
  assert.equal(excelDate("45810",false),"2025-06-02");
  assert.equal(excelDate("0",true),"1904-01-01");
  assert.equal(excelDate("",false),null);
});

test("flat CSV converts directly, preserving strings and missing values, without overwriting", async t => {
  const f = await fixture(t);
  const source = "member,employer,amount\n000123,Group A,10.10\n000123,Group A,-2.00\nOther,Group B,\n";
  await fs.writeFile(path.join(f.temporary,"redacted/report.csv"),source);
  const selected = await f.service.select("redacted/report.csv");
  assert.deepEqual((await f.service.sources()).map(s=>s.path),["redacted/report.csv"]);
  const cap = f.service.capability(selected.id);
  const result = await cap.call("report_sql",{sql:flatSQL});
  assert.deepEqual(result.at(-1).values,[[3,810]]);
  const saved = await cap.call("save_database",{tables:["events"]});
  assert.equal(saved.status,"saved");
  assert.match(saved.path,/^redacted\/report\..*\.sqlite$/);
  const SQL = await initSqlJs(), db = new SQL.Database(await fs.readFile(path.join(f.temporary,saved.path)));
  assert.deepEqual(db.exec("SELECT member,amount_cents FROM events ORDER BY source_row")[0].values,[["000123",1010],["000123",-200],["Other",null]]);
  assert.deepEqual(db.exec("PRAGMA integrity_check")[0].values,[["ok"]]);
  assert.equal(db.exec("SELECT source_rows FROM conversion_provenance")[0].values[0][0],4);
  db.close();
  assert.equal(await fs.readFile(path.join(f.temporary,"redacted/report.csv"),"utf8"),source);
  assert.notEqual((await cap.call("save_database",{tables:["events"]})).path,saved.path);
  const again = f.service.capability(selected.id);
  await again.call("report_sql",{sql:flatSQL});
  assert.notEqual((await again.call("save_database",{tables:["events"]})).path,saved.path);
});

test("XLSX inspection handles header blocks, separate employer sheets, merges and stale dimensions", async t => {
  const f = await fixture(t), book = new ExcelJS.Workbook();
  for (const name of ["Group A","Group B"]) {
    const s = book.addWorksheet(name);
    s.addRow(["Deductible","$1,000.00"]);
    s.addRow(["Employee: PERSON_A"]); s.mergeCells("A2:C2");
    s.addRow(["Member: PERSON_A"]);
    s.addRow(["000123",10.10]); s.addRow([null,-2]);
    s.addRow(["TOTAL",8.10]);
  }
  book.addWorksheet("Empty group").addRow(["Deductible","$2,000.00"]);
  const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer({useSharedStrings:true}));
  const file = "xl/worksheets/sheet1.xml";
  zip.file(file,(await zip.file(file).async("string")).replace(/<dimension[^>]+\/>/,'<dimension ref="A1:B4"/>'));
  const source = await zip.generateAsync({type:"nodebuffer"});
  await fs.writeFile(path.join(f.temporary,"redacted/blocks.xlsx"),source);
  const cap = f.service.capability((await f.service.select("redacted/blocks.xlsx")).id);
  const sql = `CREATE TABLE employer_groups AS SELECT sheet AS employer_group,money_cents(json_extract(cells_json,'$.B')) AS specific_deductible_cents FROM source_rows WHERE row=1;
    CREATE TABLE events AS SELECT e.sheet AS employer_group,e.sheet||':3' AS patient_key,regexp_extract(json_extract(m.cells_json,'$.A'),'Member: (.*)',1) AS member,json_extract(e.cells_json,'$.A') AS claim_number,money_cents(json_extract(e.cells_json,'$.B')) AS amount_cents,e.row AS source_row FROM source_rows e JOIN source_rows m ON m.sheet=e.sheet AND m.row=3 WHERE e.row IN (4,5);
    SELECT SUM(amount_cents),COUNT(*),COUNT(DISTINCT patient_key) FROM events;
    SELECT sheet,json_extract(cells_json,'$.B') FROM source_rows WHERE row=6 ORDER BY sheet;`;
  const result = await cap.call("report_sql",{sql});
  assert.deepEqual(result[0].values,[[1620,4,2]]);
  assert.equal(result[1].values.length,2);
  const saved = await cap.call("save_database",{tables:["events","employer_groups"]});
  assert.deepEqual(saved.tables,[{table:"events",rows:4},{table:"employer_groups",rows:3}]);
  assert.deepEqual(await fs.readFile(path.join(f.temporary,"redacted/blocks.xlsx")),source);
});

test("protected paths, changed sources, cancellation, and source edits cannot publish", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.temporary,"unredacted/private.csv"),"secret");
  await fs.writeFile(path.join(f.temporary,"redacted/report.csv"),"A,B,C\nx,g,1\n");
  await fs.symlink(path.join(f.temporary,"unredacted/private.csv"),path.join(f.temporary,"redacted/link.csv"));
  for (const name of ["unredacted/private.csv","redacted/../unredacted/private.csv","redacted/link.csv"]) await assert.rejects(f.service.select(name));
  const selected = await f.service.select("redacted/report.csv"), cap = f.service.capability(selected.id);
  await assert.rejects(cap.call("report_sql",{sql:"ATTACH '/tmp/outside.sqlite' AS elsewhere"}),/Only local/);
  await cap.call("report_sql",{sql:flatSQL});
  await cap.call("report_sql",{sql:"DELETE FROM source_rows"});
  await assert.rejects(cap.call("save_database",{tables:["events"]}),/Source tables were changed/);
  const cancelled = f.service.capability(selected.id); cancelled.cancel();
  await assert.rejects(cancelled.call("report_sql",{sql:"SELECT 1"}),/stopped/);
  const stale = f.service.capability(selected.id);
  await fs.appendFile(path.join(f.temporary,"redacted/report.csv"),"y,g,2\n");
  await assert.rejects(stale.call("report_sql",{sql:"SELECT 1"}),/source changed/);
  assert(!(await fs.readdir(path.join(f.temporary,"redacted"))).some(n=>n.endsWith(".sqlite")));
});

test("Claude database capability exposes only conversion tools over the private pipe", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.temporary,"redacted/report.csv"),"A,B,C\nx,g,1\n");
  const cap = f.service.capability((await f.service.select("redacted/report.csv")).id);
  const tools = createDatabaseTools(cap), server = await startRedactionServer(f.temporary,null,tools);
  t.after(()=>server.close());
  const args = claudeArguments(f.temporary,f.temporary,server.endpoint,true);
  const allowed = args[args.indexOf("--allowedTools")+1];
  assert.equal(allowed,"mcp__workspace__report_sql,mcp__workspace__save_database");
  assert.match(args[args.indexOf("--system-prompt")+1],/name: database/);
  const result = await remoteRequest(server.endpoint,{name:"report_sql",args:{sql:flatSQL}});
  assert.deepEqual(result[0].values,[[1,100]]);
  await assert.rejects(remoteRequest(server.endpoint,{name:"read_file",args:{path:"unredacted/private.csv"}}));
  assert.equal((await remoteRequest(server.endpoint,{name:"save_database",args:{tables:["events"]}})).status,"saved");
});

test('bundled descriptions preserve date exceptions and enrich without multiplying amounts', async t => {
  const {lookup}=require('../code-descriptions.cjs');
  assert.match(lookup('icd','I10','2026-06-01').description,/hypertension/i);
  assert.equal(lookup('icd','D71.8','2025-06-01').status,'not_in_date_matched_reference');
  assert.equal(lookup('icd','NOTACODE','2026-06-01').status,'unknown_code');
  assert.equal(lookup('cpt','99214',null).status,'date_unknown');
  assert.equal(lookup('cpt','99214','2027-06-01').status,'outside_bundled_period');
  assert.ok(lookup('hcpcs','J0178','2026-06-01').description);
  assert.ok(lookup('revenue','250','2026-06-01').description);
  const f=await fixture(t);
  await fs.writeFile(path.join(f.temporary,'redacted/codes.csv'),'member,cpt,icd,amount\nA,99214,I10,10.01\nA,99214,I10,-1.00\n');
  const selected=await f.service.select('redacted/codes.csv');
  const cap=f.service.capability(selected.id);
  await cap.call('report_sql',{sql:`CREATE TABLE events AS SELECT row AS source_row,json_extract(cells_json,'$.A') AS member,json_extract(cells_json,'$.B') AS cpt,json_extract(code_lookup('cpt',json_extract(cells_json,'$.B'),'2026-06-01'),'$.description') AS cpt_description,json_extract(code_lookup('icd',json_extract(cells_json,'$.C'),'2026-06-01'),'$.description') AS icd_description,money_cents(json_extract(cells_json,'$.D')) AS amount_cents FROM source_rows WHERE row>1;`});
  const saved=await cap.call('save_database',{tables:['events']});
  const SQL=await initSqlJs(),db=new SQL.Database(await fs.readFile(path.join(f.temporary,saved.path)));
  assert.deepEqual(db.exec('SELECT COUNT(*),SUM(amount_cents),COUNT(cpt_description),COUNT(icd_description) FROM events')[0].values,[[2,901,2,2]]);
  assert.equal(JSON.parse(db.exec('SELECT manifest_json FROM code_reference_provenance')[0].values[0][0]).sources.length,22);
  db.close();
});


test('normal chat keeps database context across turns and queries sources without a mode switch', async t => {
  const f=await fixture(t);
  await fs.writeFile(path.join(f.temporary,'redacted/report.csv'),'member,employer,amount\nM1,Group A,10.10\n');
  const selected=await f.service.select('redacted/report.csv');
  const first=f.service.agentAccess('conversation',selected.id);
  await first.call('report_sql',{sql:flatSQL});
  const saved=await first.call('save_database',{tables:['events']});
  assert.deepEqual((await first.call('report_sql',{sql:'SELECT COUNT(*) FROM events'}))[0].values,[[1]]);
  // Saving no longer ends access, so an omitted empty employer can be corrected now.
  await first.call('report_sql',{sql:"CREATE TABLE employers(name TEXT); INSERT INTO employers VALUES ('Group A'),('Group Empty');"});
  const corrected=await first.call('save_database',{tables:['events','employers']});
  first.cancel();
  const before=await fs.readFile(path.join(f.temporary,corrected.path));
  const followup=f.service.agentAccess('conversation');
  assert.equal(JSON.parse(followup.context).saved_database,corrected.path);
  assert.deepEqual((await followup.call('report_sql',{sql:'SELECT name FROM employers WHERE name NOT IN (SELECT employer_group FROM events)'}))[0].values,[['Group Empty']]);
  await followup.call('open_report',{path:'redacted/report.csv'});
  assert.deepEqual((await followup.call('report_sql',{sql:'SELECT COUNT(*) FROM source_rows'}))[0].values,[[2]]);
  await followup.call('open_report',{path:corrected.path});
  await followup.call('report_sql',{sql:"UPDATE employers SET name='Group Zero' WHERE name='Group Empty'"});
  assert.deepEqual(await fs.readFile(path.join(f.temporary,corrected.path)),before);
  followup.cancel();
  const next=f.service.agentAccess('conversation',selected.id);
  assert.equal(JSON.parse(next.context).report,corrected.path);
  await assert.rejects(next.call('report_sql',{sql:"ATTACH DATABASE 'unredacted/private.sqlite' AS private"}),/local conversion SQL/);
  next.cancel();
  assert.notEqual(saved.path,corrected.path);
});

test('normal chat report and file tools enforce the same protected paths and cancellation', async t => {
  const f=await fixture(t);
  await fs.writeFile(path.join(f.temporary,'unredacted/private.csv'),'secret');
  await fs.symlink(path.join(f.temporary,'unredacted/private.csv'),path.join(f.temporary,'redacted/alias.csv'));
  await fs.link(path.join(f.temporary,'unredacted/private.csv'),path.join(f.temporary,'redacted/hard.csv'));
  const access=f.service.agentAccess('protected');
  for(const file of ['unredacted/private.csv','UnReDaCtEd/private.csv','redacted/../unredacted/private.csv','/tmp/private.csv','redacted/alias.csv','redacted/hard.csv','.hidden.csv']) {
    await assert.rejects(access.call('open_report',{path:file}));
    await assert.rejects(access.call('read_file',{path:file}));
  }
  await assert.rejects(access.call('write_file',{path:'unredacted/new.txt',content:'blocked'}));
  await access.call('write_file',{path:'redacted/notes.txt',content:'permitted'});
  assert.equal((await access.call('read_file',{path:'redacted/notes.txt'})).content,'permitted');
  access.cancel();
  await assert.rejects(access.call('list_directory',{path:'redacted'}),/stopped/);
  assert.equal(await fs.readFile(path.join(f.temporary,'unredacted/private.csv'),'utf8'),'secret');
});

test('Claude normal chat exposes guarded report and file tools through the same private pipe', async t => {
  const f=await fixture(t);
  await fs.writeFile(path.join(f.temporary,'redacted/report.csv'),'member,employer,amount\nM1,A,1.01\n');
  const access=f.service.agentAccess('claude-chat');
  const server=await startRedactionServer(f.temporary,null,access);
  t.after(()=>{server.close();access.cancel();});
  const args=claudeArguments(f.temporary,f.temporary,server.endpoint,false,true);
  const allowed=args[args.indexOf('--allowedTools')+1];
  for(const name of ['open_report','report_sql','save_database','read_file']) assert.ok(allowed.includes(`mcp__workspace__${name}`));
  assert.equal(allowed.includes('run_redaction_script'),false);
  await remoteRequest(server.endpoint,{name:'open_report',args:{path:'redacted/report.csv'}});
  const result=await remoteRequest(server.endpoint,{name:'report_sql',args:{sql:'SELECT COUNT(*) FROM source_rows'}});
  assert.deepEqual(result[0].values,[[2]]);
  await assert.rejects(remoteRequest(server.endpoint,{name:'open_report',args:{path:'unredacted/private.csv'}}));
  const content='a'.repeat(600000);
  await remoteRequest(server.endpoint,{name:'write_file',args:{path:'redacted/large.txt',content}});
  assert.equal((await remoteRequest(server.endpoint,{name:'read_file',args:{path:'redacted/large.txt'}})).content,content);
});
