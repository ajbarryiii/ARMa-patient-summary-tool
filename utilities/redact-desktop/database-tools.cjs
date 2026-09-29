"use strict";
const { WorkspaceError } = require("./workspace-tools.cjs");
const TOOLS = [
  { name: "report_sql", description: "Inspect the selected redacted report and build its SQLite tables with SQL. Spreadsheet inputs expose source_sheets and source_rows; opened SQLite files keep their tables. Inspect sqlite_master for the schema. Runs only in the local in-memory worker. Results are bounded to 100 rows per result and 48,000 characters.", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"], additionalProperties: false } },
  { name: "save_database", description: "Save the checked ordinary output tables as a new SQLite database in redacted. No manual review. Does not overwrite existing files. Further queries and saves remain available; each save creates a new revision.", inputSchema: { type: "object", properties: { tables: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 } }, required: ["tables"], additionalProperties: false } },
];
function createDatabaseTools(capability) {
  return {
    ready: Promise.resolve(), tools: TOOLS,
    async call(name,args) {
      const key = name === "report_sql" ? "sql" : name === "save_database" ? "tables" : null;
      if (!key || !args || Array.isArray(args) || Object.keys(args).length !== 1 || !(key in args) || (key === "sql" ? typeof args.sql !== "string" : !Array.isArray(args.tables))) throw new WorkspaceError("Invalid database tool arguments.");
      try { return await capability.call(name,args); }
      catch (error) { throw new WorkspaceError(error instanceof WorkspaceError ? error.message : "Database conversion could not complete."); }
    },
  };
}
if (require.main === module) {
  const { serve, remoteRequest } = require("./redaction-tools.cjs");
  serve(process.env.ARMA_REDACTION_PIPE,createDatabaseTools({ call: (name,args) => remoteRequest(process.env.ARMA_REDACTION_PIPE,{ name, args }) })).catch(() => { process.stderr.write("Local database connection stopped.\n"); process.exitCode = 1; });
}
module.exports = { TOOLS, createDatabaseTools };
