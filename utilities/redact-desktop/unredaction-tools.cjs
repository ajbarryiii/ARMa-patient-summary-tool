"use strict";
const { WorkspaceError } = require("./workspace-tools.cjs");
const PLAN = { version: 1, operation: "restore_patient_summaries", token_column: "replacement", original_column: "original" };
const TOOL = {
  name: "run_unredaction_script",
  description: "Generate and run a local identity-restoration script for the operator-selected patient summaries and mapping CSVs. Saves separate Word copies in unredacted/Patient Summaries. Returns only counts and a generated output folder; private mappings, restored text and filenames never enter the response. One execution per message.",
  inputSchema: { type: "object", properties: { schema_json: { type: "string", description: "JSON version 1, operation restore_patient_summaries, token_column replacement, original_column original." } }, required: ["schema_json"], additionalProperties: false },
};
function validatePlan(args) {
  try {
    if (!args || Array.isArray(args) || Object.keys(args).length !== 1 || typeof args.schema_json !== "string" || args.schema_json.length > 1000) throw new Error();
    const plan = JSON.parse(args.schema_json);
    if (!plan || Object.keys(plan).length !== Object.keys(PLAN).length || Object.entries(PLAN).some(([key, value]) => plan[key] !== value)) throw new Error();
    return { ...PLAN };
  } catch { throw new WorkspaceError("Use the restoration plan from the Unredact Summaries skill."); }
}
if (require.main === module) {
  const { serve, remoteRequest } = require("./redaction-tools.cjs");
  serve(process.env.ARMA_REDACTION_PIPE, { ready: Promise.resolve(), tools: [TOOL], call: async (name, args) => {
    try { return await remoteRequest(process.env.ARMA_REDACTION_PIPE, { name, args }); }
    catch (error) { throw new WorkspaceError(error.message); }
  } }).catch(() => {
    process.stderr.write("Local identity restoration connection stopped.\n"); process.exitCode = 1;
  });
}
module.exports = { TOOL, PLAN, validatePlan };
