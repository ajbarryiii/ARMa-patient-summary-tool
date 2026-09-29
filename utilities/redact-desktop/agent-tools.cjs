"use strict";
const { TOOLS: FILE_TOOLS, WorkspaceError } = require('./workspace-tools.cjs');
const { TOOLS: DATABASE_TOOLS } = require('./database-tools.cjs');
const TOOLS = [ ...FILE_TOOLS,
  {name:'open_report',description:'Open a permitted workspace XLSX/CSV/TSV report or SQLite database for local SQL inspection, conversion, or follow-up questions. Returns table schemas. Use a workspace-relative path; unredacted and other protected paths are blocked.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  ...DATABASE_TOOLS,
  ...require('./patient-summary-tools.cjs').TOOLS,
];
function remoteTools(endpoint) {
  const {remoteRequest}=require('./redaction-tools.cjs');
  return {ready:Promise.resolve(),tools:TOOLS,call:(name,args)=>remoteRequest(endpoint,{name,args})};
}
if(require.main===module) {
  require('./redaction-tools.cjs').serve(process.env.ARMA_REDACTION_PIPE,remoteTools(process.env.ARMA_REDACTION_PIPE)).catch(()=>{process.stderr.write('Local workspace connection stopped.\n');process.exitCode=1;});
}
module.exports={TOOLS};
