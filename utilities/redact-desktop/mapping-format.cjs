"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const HEADERS = ["field", "original", "replacement", "occurrences"];
const REFERENCE_NAME = "Mapping CSV columns.md";
const REFERENCE = `# Redaction mapping CSV columns

Redact saves a UTF-8 mapping CSV in each local redaction run:
\`unredacted/redaction-runs/<run-id>/mapping.csv\`.

\`field,original,replacement,occurrences\`

| Column | Meaning |
| --- | --- |
| field | Field label from the redaction rule, such as patient_name or member_id. |
| original | Exact original text. This column contains private information and stays local. |
| replacement | Opaque token inserted into the redacted source, consisting of the rule prefix, an underscore, and 16 hexadecimal characters. |
| occurrences | Number of source occurrences replaced during that redaction run. This is not a payment, claim count, or restoration count. |

Fields may be quoted; doubled quotes, commas, and newlines inside quoted values are preserved. Empty source fields do not create mapping rows. Each field and original value pair has one token per run. Tokens are not shared across runs.

Unredact Summaries reverses exact replacement tokens to original text using only the mapping CSVs selected locally for that report set. It preserves the redacted summaries and writes new Word copies under \`unredacted/Patient Summaries/\`. Mapping values and restored documents are never sent to a model provider. The agent receives this fixed column schema through the bundled skill, without opening this private folder.
`;
async function ensureMappingReference(workspace) {
  const parent = await workspace.resolve("unredacted");
  try { await fs.writeFile(path.join(parent, REFERENCE_NAME), REFERENCE, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  // Leave existing operator edits intact, but never accept a linked reference.
  const existing = await workspace.resolve(`unredacted/${REFERENCE_NAME}`);
  const stat = await fs.lstat(existing);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("The mapping column reference must be an ordinary file without links.");
}
module.exports = { HEADERS, REFERENCE_NAME, REFERENCE, ensureMappingReference };
