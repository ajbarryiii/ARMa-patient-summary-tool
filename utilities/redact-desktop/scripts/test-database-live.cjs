"use strict";
// Opt-in: uses the installed Codex login and sends only disposable synthetic data.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const initSqlJs=require('sql.js');
const {AgentBridge}=require('../agents.cjs');
const {Workspace}=require('../workspace.cjs');
const {DatabaseService}=require('../database.cjs');
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'arma-database-live-'));
  const workspace=new Workspace(); await workspace.open(root);
  const book=new ExcelJS.Workbook();
  for(const [name,deductible,member] of [['Synthetic A',1000,'MEMBER_A'],['Synthetic B',2000,'MEMBER_B']]){
    const sheet=book.addWorksheet(name);
    sheet.addRow(['Employer group',name,'Deductible',deductible]);
    sheet.addRow(['Employee: EMPLOYEE_X']);
    sheet.addRow([`Member: ${member}`]);
    sheet.addRow(['Employee','Member','Service date','CPT','ICD','Paid']);
    sheet.addRow(['','','2026-06-01','99214','I10','10.01']);
    sheet.addRow(['','','2026-06-02','99214','I10','-1.00']);
    sheet.addRow(['Total','','','','','9.01']);
  }
  book.addWorksheet('Synthetic Empty').addRow(['Employer group','Synthetic Empty','Deductible',3000]);
  await book.xlsx.writeFile(path.join(root,'redacted/Synthetic.xlsx'));
  const service=new DatabaseService(workspace),bridge=new AgentBridge({allowCodex:true,runtimeParent:root});
  const calls=[];let saved,output='',failure;
  try {
    const selected=await service.select('redacted/Synthetic.xlsx');
    const run=async(prompt,sourceId)=>{
      let response='',failure;
      const cap=service.agentAccess('live-database',sourceId);
      const access={...cap,call:async(name,args)=>{
        calls.push({name,args}); console.log('Tool:',name);
        const result=await cap.call(name,args);if(name==='save_database')saved=result;return result;
      }};
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{bridge.dispose();reject(new Error('Live database turn timed out.'));},240000);
        bridge.start({provider:'codex',model:'gpt-6-sol',effort:'medium',workspace:root,conversationId:'live-database',access,prompt},event=>{
          if(event.type==='delta') response+=event.text;
          if(event.type==='error') failure=event.text;
          if(event.type==='done'){clearTimeout(timer);failure?reject(new Error(failure)):resolve();}
        }).catch(error=>{clearTimeout(timer);reject(error);});
      });
      return response;
    };
    output=await run('Convert the selected synthetic workbook to SQLite. Each sheet is one employer group, with its deductible in row 1 column D. Employee and Member header rows explicitly start each patient block; use that member for all following events until the Total row. The same employee label across sheets does not merge people. On nonempty sheets row 4 is the event header; rows 5-6 are events and row 7 is a subtotal to exclude. Combine into one events table with member, employer_group, group_deductible_cents, paid_cents, cpt, cpt_description, icd, icd_description, source_sheet and source_row. Also create an employers table with employer_group and group_deductible_cents for every sheet, including groups without events. Enrich from bundled descriptions, preserve reference/status columns as needed, check group totals and save now without manual review.',selected.id);
    assert.ok(saved,'Codex did not save a database. '+output);
    const SQL=await initSqlJs(),db=new SQL.Database(await fs.readFile(path.join(root,saved.path)));
    try {
      assert.deepEqual(db.exec('SELECT COUNT(*),SUM(paid_cents),COUNT(cpt_description),COUNT(icd_description) FROM events')[0].values,[[4,1802,4,4]]);
      assert.deepEqual(db.exec('SELECT member,employer_group,group_deductible_cents,SUM(paid_cents) FROM events GROUP BY member,employer_group,group_deductible_cents ORDER BY member')[0].values,[['MEMBER_A','Synthetic A',100000,901],['MEMBER_B','Synthetic B',200000,901]]);
      assert.match(db.exec('SELECT icd_description FROM events LIMIT 1')[0].values[0][0],/hypertension/i);
      assert.ok(calls.some(c=>c.name==='report_sql'));assert.ok(calls.some(c=>c.name==='save_database'));
      assert.deepEqual(db.exec("SELECT group_deductible_cents FROM employers WHERE employer_group='Synthetic Empty'")[0].values,[[300000]]);
      console.log('Live Codex XLSX conversion passed: 4 events, exact totals, two groups, CPT and ICD descriptions.');
    } finally {db.close();}
    const count=calls.length;
    const answer=await run('Which employer groups have no events? Check the original workbook too: do those groups have any people listed? Answer this follow-up without creating another database.');
    assert.match(answer,/Synthetic Empty/i);
    assert.match(answer,/no (?:people|members|patients)|0 (?:people|members|patients)|zero (?:people|members|patients)/i);
    assert.ok(calls.slice(count).some(c=>c.name==='report_sql'));
    assert.ok(calls.slice(count).some(c=>c.name==='open_report' && c.args.path==='redacted/Synthetic.xlsx'));
    assert.equal(calls.slice(count).some(c=>c.name==='save_database'),false);
    console.log('Live normal-chat follow-up passed: saved database and original workbook queried; empty employer retained, no listed people, no redundant save.');
  } finally {bridge.dispose();service.dispose();await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
