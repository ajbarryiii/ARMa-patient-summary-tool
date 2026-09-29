"use strict";
const fs = require("node:fs");
const path = require("node:path");
const REDACTION_SKILL = fs.readFileSync(
  path.join(__dirname, "skills/redact/SKILL.md"),
  "utf8",
);
const REDACTION_PLACEHOLDER =
  "What should be redacted? For example: column B, or names and IDs in “Employee: Name (ID)” rows.";
const DATABASE_SKILL = fs.readFileSync(path.join(__dirname, "skills/database/SKILL.md"), "utf8");
const DATABASE_PLACEHOLDER = "Describe how the file is laid out and how you want the data arranged in the database.";
const PATIENT_SUMMARY_SKILL = fs.readFileSync(path.join(__dirname, "skills/patient-summaries/SKILL.md"), "utf8");
const PATIENT_SUMMARY_PLACEHOLDER = "Create a concise Word summary for each patient in the selected database.";
const UNREDACTION_SKILL = fs.readFileSync(path.join(__dirname, "skills/unredact-summaries/SKILL.md"), "utf8");
const UNREDACTION_PLACEHOLDER = "Create and run a local tool to unredact the selected patient summaries using the selected mapping CSVs.";
const WORKFLOW_GUIDANCE = " Normal workspace chat includes open_report, report_sql and save_database for permitted XLSX/CSV/TSV and SQLite files, plus guarded file tools. Use these tools directly for conversions and follow-up questions; the Database button only selects a source and helps compose the initial request. Do not ask the operator to activate a mode, export XLSX as CSV, or resubmit a conversion merely to answer a question. When the current database omits source information, open the original permitted report and inspect it. Never infer that no event rows means no listed people. Keep working until the requested result is complete, including metadata for groups with no events. Saved files are immutable revisions; a correction saves a new file. The unredacted folder remains blocked by application code on every tool call. No shell or unrestricted host filesystem is available. Code descriptions are bundled locally; preserve unknown-code and date exceptions.";
module.exports = { WORKFLOW_GUIDANCE, REDACTION_SKILL, REDACTION_PLACEHOLDER, DATABASE_SKILL, DATABASE_PLACEHOLDER, PATIENT_SUMMARY_SKILL, PATIENT_SUMMARY_PLACEHOLDER, UNREDACTION_SKILL, UNREDACTION_PLACEHOLDER };
